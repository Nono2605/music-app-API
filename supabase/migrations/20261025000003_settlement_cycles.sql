-- Règlement des abonnements : cycles, journal d'écritures, règlement à la fin de la période, disponibilité 24 h plus tard
-- (docs/SPEC_REMUNERATION.md, sections 9 et 17.2, simplifiées le 25 octobre 2026).
--
-- LA RÈGLE
--   1. Chaque paiement d'abonnement ouvre UN cycle : de la date de paiement à la fin de la période de service.
--   2. À la fin de la période, le cycle est réglé : la base (montant payé - TVA - frais Stripe) est partagée en une part
--      artistes (85 %) et une part Vynl (15 %). La part artistes est répartie entre les morceaux écoutés par CET abonné
--      pendant la période, au prorata des secondes écoutées (écoutes qualifiées d'au moins 30 s, comptées, d'un abonné
--      payant). Sans écoute qualifiée, la part artistes va à la pool commune.
--   3. Les crédits des artistes sont « en attente », puis « disponibles » 24 h après le règlement. Un remboursement, un
--      litige ou un événement de fraude ouvert les RETIENT : le cycle apparaît dans la file d'exceptions de l'admin.
--
-- TVA : aucune règle de taux ici. La base se lit sur le paiement (montant - taxe - frais) ; tant que Stripe Tax est
-- éteint, la taxe de chaque paiement est 0. Le jour où la TVA s'applique, rien n'est à recoder.
--
-- ARGENT : en micro-unités (1 CHF = 1 000 000), entiers. Une répartition ne perd ni ne crée jamais une micro-unité : le
-- reste de l'arrondi va aux plus grands restes (puis par identifiant), de façon déterminée. La somme des écritures d'un
-- cycle est toujours égale à sa base.
--
-- JOURNAL : les écritures ne se modifient ni ne se suppriment jamais. Une correction est une écriture inverse. Le solde
-- d'un artiste se calcule depuis le journal (vue artist_balances), jamais depuis un total stocké.
--
-- Rien n'est versé : ni retrait ni transfert (étape suivante). Les anciennes tables mensuelles (royalty_periods,
-- royalty_allocations, creator_wallets) ne sont ni modifiées ni lues ici ; elles seront retirées plus tard.
--
-- Prérequis : payments (20261013200000), plays (20261009000002), fraud_events (init), artists, tracks, users. Idempotente.

-- 1. Les règles, versionnées ------------------------------------------------------------------------------------------

create table if not exists settlement_rules (
  version                  integer primary key check (version >= 1),
  -- Part des artistes sur la base, en points de base : 8500 = 85 %.
  artist_share_bps         integer not null check (artist_share_bps between 0 and 10000),
  -- Délai entre le règlement et la disponibilité des crédits.
  availability_delay_hours integer not null check (availability_delay_hours >= 0),
  -- Retenue supplémentaire sur les TOUT PREMIERS gains d'un artiste (spec V6 : 30 jours ; 0 = désactivée, en attendant
  -- l'avis du juriste sur la retenue de première rémunération).
  first_earnings_hold_days integer not null default 0 check (first_earnings_hold_days >= 0),
  note                     text,
  created_at               timestamptz not null default now()
);

insert into settlement_rules (version, artist_share_bps, availability_delay_hours, first_earnings_hold_days, note)
values (1, 8500, 24, 0, 'Spec v0.7 simplifiée le 25 oct. 2026 : 85 % aux artistes, disponible 24 h après le règlement.')
on conflict (version) do nothing;

-- Une règle publiée ne change plus : une nouvelle règle est une nouvelle version, que les NOUVEAUX cycles utilisent.
create or replace function settlement_rules_guard() returns trigger
  language plpgsql set search_path = public as $$
begin
  raise exception 'Settlement rules are never changed or deleted: add a new version' using errcode = '23514';
end $$;

drop trigger if exists settlement_rules_guard on settlement_rules;
create trigger settlement_rules_guard before update or delete on settlement_rules
  for each row execute function settlement_rules_guard();

-- 2. Les cycles -------------------------------------------------------------------------------------------------------

create table if not exists settlement_cycles (
  id             uuid primary key default gen_random_uuid(),
  -- Un paiement, un cycle. Un paiement n'est jamais supprimé (garde-fou de payments).
  payment_id     uuid not null unique references payments(id) on delete restrict,
  -- L'abonné. Devient nul si son compte est supprimé : le cycle en cours est réglé AVANT (étape suivante).
  user_id        uuid references users(id) on delete set null,
  currency       text not null check (currency ~ '^[a-z]{3}$'),
  period_start   timestamptz not null,
  period_end     timestamptz not null,
  rules_version  integer not null references settlement_rules(version),
  -- open : en cours ; held : à examiner (file d'exceptions) ; settled : réglé ; cancelled : annulé.
  status         text not null default 'open' check (status in ('open', 'held', 'settled', 'cancelled')),
  opened_at      timestamptz not null default now(),

  -- Renseignés au règlement, figés ensuite.
  base_micro     bigint check (base_micro >= 0),
  artist_micro   bigint check (artist_micro >= 0),   -- réparti entre les artistes
  platform_micro bigint check (platform_micro >= 0), -- part de Vynl
  pool_micro     bigint check (pool_micro >= 0),     -- part artistes sans écoute à répartir : pool commune
  total_seconds  numeric(14, 3) check (total_seconds >= 0),
  settled_at     timestamptz,
  available_at   timestamptz,                        -- règlement + délai de disponibilité

  cancelled_at   timestamptz,
  cancelled_by   uuid references users(id) on delete set null,
  cancel_reason  text check (cancel_reason is null or char_length(cancel_reason) <= 500),

  constraint settlement_cycles_period check (period_end > period_start),
  constraint settlement_cycles_settled_complete check (
    status <> 'settled' or (
      base_micro is not null and artist_micro is not null and platform_micro is not null and pool_micro is not null
      and total_seconds is not null and settled_at is not null and available_at is not null
    )
  ),
  constraint settlement_cycles_settled_status check (settled_at is null or status in ('settled', 'cancelled')),
  constraint settlement_cycles_adds_up check (
    base_micro is null or artist_micro + platform_micro + pool_micro = base_micro
  ),
  constraint settlement_cycles_cancelled_complete check (status <> 'cancelled' or (cancelled_at is not null and cancel_reason is not null))
);

create index if not exists idx_settlement_cycles_due on settlement_cycles (period_end) where status = 'open';
create index if not exists idx_settlement_cycles_status on settlement_cycles (status, period_end);
create index if not exists idx_settlement_cycles_user on settlement_cycles (user_id, period_start, period_end);

create or replace function settlement_cycles_guard() returns trigger
  language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Settlement cycles are never deleted' using errcode = '23514';
  end if;

  if new.id <> old.id or new.payment_id <> old.payment_id or new.currency <> old.currency
     or new.period_start <> old.period_start or new.period_end <> old.period_end
     or new.rules_version <> old.rules_version or new.opened_at <> old.opened_at
     or (new.user_id is distinct from old.user_id and new.user_id is not null) then
    raise exception 'The identity of a settlement cycle cannot change' using errcode = '23514';
  end if;

  -- Un cycle réglé est immuable : seuls son statut (réglé -> annulé, par écriture inverse) et son annulation bougent.
  if old.settled_at is not null and (
       new.base_micro is distinct from old.base_micro or new.artist_micro is distinct from old.artist_micro
    or new.platform_micro is distinct from old.platform_micro or new.pool_micro is distinct from old.pool_micro
    or new.total_seconds is distinct from old.total_seconds or new.settled_at is distinct from old.settled_at
    or new.available_at is distinct from old.available_at) then
    raise exception 'A settled cycle cannot change' using errcode = '23514';
  end if;

  if new.status <> old.status and not (
       (old.status = 'open' and new.status in ('held', 'settled', 'cancelled'))
    or (old.status = 'held' and new.status in ('open', 'cancelled'))
    or (old.status = 'settled' and new.status = 'cancelled')) then
    raise exception 'A settlement cycle cannot go from % to %', old.status, new.status using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists settlement_cycles_guard on settlement_cycles;
create trigger settlement_cycles_guard before update or delete on settlement_cycles
  for each row execute function settlement_cycles_guard();

-- 3. Les retenues (file d'exceptions) ---------------------------------------------------------------------------------

create table if not exists cycle_holds (
  id           uuid primary key default gen_random_uuid(),
  cycle_id     uuid not null references settlement_cycles(id) on delete restrict,
  -- dispute : réservé (le suivi des litiges Stripe viendra avec les retraits).
  reason       text not null check (reason in ('refund', 'dispute', 'fraud', 'fee_unknown', 'manual')),
  detail       text check (detail is null or char_length(detail) <= 500),
  created_at   timestamptz not null default now(),
  released_at  timestamptz,
  released_by  uuid references users(id) on delete set null,
  release_note text check (release_note is null or char_length(release_note) <= 500)
);

-- Une seule retenue active par cycle et par raison.
create unique index if not exists idx_cycle_holds_active on cycle_holds (cycle_id, reason) where released_at is null;
create index if not exists idx_cycle_holds_cycle on cycle_holds (cycle_id);

create or replace function cycle_holds_guard() returns trigger
  language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Cycle holds are never deleted' using errcode = '23514';
  end if;
  if new.id <> old.id or new.cycle_id <> old.cycle_id or new.reason <> old.reason
     or new.detail is distinct from old.detail or new.created_at <> old.created_at then
    raise exception 'Only the release of a cycle hold can be recorded' using errcode = '23514';
  end if;
  if old.released_at is not null then
    raise exception 'A released hold cannot change' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists cycle_holds_guard on cycle_holds;
create trigger cycle_holds_guard before update or delete on cycle_holds
  for each row execute function cycle_holds_guard();

-- 4. Le détail du partage : une ligne par morceau et par artiste ------------------------------------------------------

create table if not exists cycle_allocations (
  id           bigint generated always as identity primary key,
  cycle_id     uuid not null references settlement_cycles(id) on delete restrict,
  track_id     uuid not null references tracks(id) on delete restrict,
  artist_id    uuid not null references artists(id) on delete restrict,
  -- Les secondes comptées pour ce cycle (copiées : l'écoute peut encore recevoir un battement tardif après le règlement).
  seconds      numeric(14, 3) not null check (seconds > 0),
  amount_micro bigint not null check (amount_micro >= 0),
  unique (cycle_id, track_id, artist_id)
);

create index if not exists idx_cycle_allocations_artist on cycle_allocations (artist_id);

-- 5. Le journal -------------------------------------------------------------------------------------------------------

create table if not exists ledger_entries (
  id                bigint generated always as identity primary key,
  cycle_id          uuid not null references settlement_cycles(id) on delete restrict,
  account           text not null check (account in ('artist', 'platform', 'pool')),
  artist_id         uuid references artists(id) on delete restrict,
  -- credit : positif ; reversal : négatif, il annule UNE écriture.
  entry_type        text not null check (entry_type in ('credit', 'reversal')),
  amount_micro      bigint not null check (amount_micro <> 0),
  currency          text not null check (currency ~ '^[a-z]{3}$'),
  -- Pour les crédits d'artiste : quand ils deviennent disponibles. Une écriture inverse reprend celle de l'écriture annulée.
  available_at      timestamptz,
  reverses_entry_id bigint references ledger_entries(id) on delete restrict,
  created_at        timestamptz not null default now(),
  constraint ledger_artist_account check ((account = 'artist') = (artist_id is not null)),
  constraint ledger_available_for_artists check ((account = 'artist') = (available_at is not null)),
  constraint ledger_credit_positive check (entry_type <> 'credit' or (amount_micro > 0 and reverses_entry_id is null)),
  constraint ledger_reversal_negative check (entry_type <> 'reversal' or (amount_micro < 0 and reverses_entry_id is not null))
);

create unique index if not exists idx_ledger_one_reversal on ledger_entries (reverses_entry_id) where reverses_entry_id is not null;
create index if not exists idx_ledger_cycle on ledger_entries (cycle_id);
create index if not exists idx_ledger_artist on ledger_entries (artist_id, available_at) where artist_id is not null;

create or replace function settlement_append_only() returns trigger
  language plpgsql set search_path = public as $$
begin
  raise exception '% is append-only: rows are never changed or deleted', tg_table_name using errcode = '23514';
end $$;

drop trigger if exists ledger_entries_append_only on ledger_entries;
create trigger ledger_entries_append_only before update or delete on ledger_entries
  for each row execute function settlement_append_only();

drop trigger if exists cycle_allocations_append_only on cycle_allocations;
create trigger cycle_allocations_append_only before update or delete on cycle_allocations
  for each row execute function settlement_append_only();

-- 6. Ouvrir un cycle --------------------------------------------------------------------------------------------------

-- Idempotente : rend le cycle du paiement (existant ou créé). Rend null quand il n'y a rien à partager : paiement sans
-- abonné, sans période de service, ou de 0 (offre gratuite, essai).
create or replace function settlement_open_cycle(p_payment uuid) returns uuid
  language plpgsql as $$
declare
  v_pay payments%rowtype;
  v_id uuid;
  v_rules integer;
begin
  select * into v_pay from payments where id = p_payment;
  if not found then raise exception 'Payment not found' using errcode = 'P0002'; end if;

  select id into v_id from settlement_cycles where payment_id = p_payment;
  if found then return v_id; end if;

  if v_pay.user_id is null or v_pay.service_period_start is null or v_pay.service_period_end is null
     or v_pay.service_period_end <= v_pay.service_period_start
     or v_pay.gross_cents - v_pay.tax_cents <= 0 then
    return null;
  end if;

  select max(version) into v_rules from settlement_rules;
  insert into settlement_cycles (payment_id, user_id, currency, period_start, period_end, rules_version)
  values (v_pay.id, v_pay.user_id, v_pay.currency, v_pay.service_period_start, v_pay.service_period_end, v_rules)
  on conflict (payment_id) do nothing
  returning id into v_id;

  if v_id is null then select id into v_id from settlement_cycles where payment_id = p_payment; end if;
  return v_id;
end $$;

-- 7. Les contrôles automatiques ---------------------------------------------------------------------------------------

-- La raison pour laquelle un cycle doit être examiné, ou aucune ligne. Une raison déjà examinée et libérée PAR UN ADMIN pour
-- ce cycle n'est pas relevée de nouveau ; une retenue libérée automatiquement (la cause avait disparu) ne dispense de rien.
create or replace function settlement_check_reason(p_cycle uuid) returns table (reason text, detail text)
  language plpgsql stable as $$
declare
  c settlement_cycles%rowtype;
  v_pay payments%rowtype;
begin
  select * into c from settlement_cycles where id = p_cycle;
  select * into v_pay from payments where id = c.payment_id;

  if v_pay.refunded_cents > 0
     and not exists (select 1 from cycle_holds h where h.cycle_id = c.id and h.reason = 'refund' and h.released_at is not null and h.released_by is not null) then
    return query select 'refund'::text, format('Payment refunded: %s of %s cents', v_pay.refunded_cents, v_pay.gross_cents);
    return;
  end if;

  if v_pay.fee_cents is null and c.settled_at is null
     and not exists (select 1 from cycle_holds h where h.cycle_id = c.id and h.reason = 'fee_unknown' and h.released_at is not null and h.released_by is not null) then
    return query select 'fee_unknown'::text, 'The payment processing fee is not known yet'::text;
    return;
  end if;

  if exists (select 1 from fraud_events f where f.user_id = c.user_id and not f.resolved and f.detected_at >= c.period_start)
     and not exists (select 1 from cycle_holds h where h.cycle_id = c.id and h.reason = 'fraud' and h.released_at is not null and h.released_by is not null) then
    return query select 'fraud'::text, 'An open fraud event concerns this subscriber'::text;
    return;
  end if;
end $$;

-- Les secondes écoutées par l'abonné d'un cycle, par morceau et par artiste : écoutes qualifiées (30 s), comptées (non
-- exclues pour fraude), d'abonné payant, devenues qualifiées PENDANT la période (début inclus, fin exclue).
create or replace function settlement_cycle_seconds(p_cycle uuid) returns table (track_id uuid, artist_id uuid, secs numeric)
  language sql stable as $$
  select p.track_id, p.artist_id, sum(p.validated_seconds)
    from settlement_cycles c
    join plays p on p.user_id = c.user_id
   where c.id = p_cycle
     and p.entitlement = 'subscriber' and p.qualified and p.counted
     and p.qualified_at >= c.period_start and p.qualified_at < c.period_end
   group by p.track_id, p.artist_id
  having sum(p.validated_seconds) > 0 $$;

-- La cause d'une retenue a-t-elle disparu d'elle-même ? Frais Stripe connus, événement de fraude résolu. Un remboursement ne
-- disparaît jamais ; une retenue « manual » ou « dispute » ne se libère que par un admin.
create or replace function settlement_hold_cleared(p_hold uuid) returns boolean
  language sql stable as $$
  select case h.reason
           when 'fee_unknown' then pay.fee_cents is not null
           when 'fraud' then not exists (
             select 1 from fraud_events f where f.user_id = c.user_id and not f.resolved and f.detected_at >= c.period_start)
           else false
         end
    from cycle_holds h
    join settlement_cycles c on c.id = h.cycle_id
    join payments pay on pay.id = c.payment_id
   where h.id = p_hold $$;

-- 8. Régler un cycle --------------------------------------------------------------------------------------------------

-- Règle UN cycle échu, en une transaction. Rend : settled | held | cancelled | not_due | <statut actuel> (déjà traité).
create or replace function settlement_settle_cycle(p_cycle uuid, p_now timestamptz default now()) returns text
  language plpgsql as $$
declare
  c settlement_cycles%rowtype;
  v_pay payments%rowtype;
  v_rules settlement_rules%rowtype;
  v_reason text;
  v_detail text;
  v_net bigint;
  v_base bigint;
  v_artist_share bigint;
  v_platform bigint;
  v_total numeric;
  v_missing bigint;
  v_available timestamptz;
  v_artist bigint;
  v_pool bigint;
  v_sum bigint;
begin
  select * into c from settlement_cycles where id = p_cycle for update;
  if not found then raise exception 'Settlement cycle not found' using errcode = 'P0002'; end if;
  if c.status <> 'open' then return c.status; end if;
  if c.period_end > p_now then return 'not_due'; end if;

  select * into v_pay from payments where id = c.payment_id;
  select * into v_rules from settlement_rules where version = c.rules_version;

  select r.reason, r.detail into v_reason, v_detail from settlement_check_reason(c.id) r;
  if v_reason is not null then
    insert into cycle_holds (cycle_id, reason, detail) values (c.id, v_reason, v_detail)
    on conflict (cycle_id, reason) where (released_at is null) do nothing;
    update settlement_cycles set status = 'held' where id = c.id;
    return 'held';
  end if;

  v_net := v_pay.gross_cents - v_pay.tax_cents - v_pay.fee_cents;
  if v_net <= 0 then
    update settlement_cycles set status = 'cancelled', cancelled_at = p_now, cancel_reason = 'Nothing to share after tax and fees' where id = c.id;
    return 'cancelled';
  end if;

  -- 1 centime = 10 000 micro-unités. 85 % d'un nombre entier de centimes est un nombre entier de micro-unités.
  v_base := v_net * 10000;
  v_artist_share := (v_base * v_rules.artist_share_bps) / 10000;
  v_platform := v_base - v_artist_share;

  select coalesce(sum(secs), 0) into v_total from settlement_cycle_seconds(c.id);

  if v_total > 0 then
    -- Plus grands restes : chaque part est arrondie vers le bas, puis le reste va, une micro-unité à la fois, aux plus
    -- grandes parties fractionnaires (à égalité : par morceau, puis par artiste). La somme est exacte.
    with exact as (
      select s.track_id, s.artist_id, s.secs, v_artist_share::numeric * s.secs / v_total as x from settlement_cycle_seconds(c.id) s
    ), floored as (
      select e.*, floor(e.x)::bigint as fl, e.x - floor(e.x) as frac from exact e
    ), shortfall as (
      select v_artist_share - sum(fl) as missing from floored
    ), ranked as (
      select f.*, row_number() over (order by f.frac desc, f.track_id, f.artist_id) as rn from floored f
    )
    insert into cycle_allocations (cycle_id, track_id, artist_id, seconds, amount_micro)
    select c.id, r.track_id, r.artist_id, r.secs, r.fl + case when r.rn <= (select missing from shortfall) then 1 else 0 end
      from ranked r;
    v_artist := v_artist_share;
    v_pool := 0;
  else
    v_artist := 0;
    v_pool := v_artist_share;
  end if;

  v_available := p_now + make_interval(hours => v_rules.availability_delay_hours);

  -- Un crédit par artiste. Les TOUT PREMIERS gains d'un artiste peuvent être retenus plus longtemps (règle V6, désactivée
  -- par défaut). `ledger_entries` ne contient pas encore ce cycle : « premier » veut dire « aucun crédit avant ».
  insert into ledger_entries (cycle_id, account, artist_id, entry_type, amount_micro, currency, available_at)
  select c.id, 'artist', a.artist_id, 'credit', a.total, c.currency,
         v_available + case
           when v_rules.first_earnings_hold_days > 0
                and not exists (select 1 from ledger_entries x where x.account = 'artist' and x.artist_id = a.artist_id and x.entry_type = 'credit')
           then make_interval(days => v_rules.first_earnings_hold_days)
           else interval '0'
         end
    from (select artist_id, sum(amount_micro) as total from cycle_allocations where cycle_id = c.id group by artist_id having sum(amount_micro) > 0) a;

  if v_platform > 0 then
    insert into ledger_entries (cycle_id, account, entry_type, amount_micro, currency) values (c.id, 'platform', 'credit', v_platform, c.currency);
  end if;
  if v_pool > 0 then
    insert into ledger_entries (cycle_id, account, entry_type, amount_micro, currency) values (c.id, 'pool', 'credit', v_pool, c.currency);
  end if;

  -- Filet de sécurité : le journal de ce cycle doit valoir exactement sa base.
  select coalesce(sum(amount_micro), 0) into v_sum from ledger_entries where cycle_id = c.id;
  if v_sum <> v_base then
    raise exception 'Settlement of cycle % does not add up: ledger % for a base of %', c.id, v_sum, v_base;
  end if;

  update settlement_cycles
     set status = 'settled', base_micro = v_base, artist_micro = v_artist, platform_micro = v_platform, pool_micro = v_pool,
         total_seconds = v_total, settled_at = p_now, available_at = v_available
   where id = c.id;
  return 'settled';
end $$;

-- 9. Libérer une retenue, annuler un cycle ----------------------------------------------------------------------------

-- L'admin a examiné la retenue et décide de continuer. Un cycle « held » repasse « open » (réglé au prochain passage) s'il
-- n'a plus d'autre retenue ; un cycle déjà réglé voit simplement ses crédits redevenir disponibles. Rend le statut du cycle.
create or replace function settlement_release_hold(p_hold uuid, p_admin uuid, p_note text default null) returns text
  language plpgsql as $$
declare
  v_hold cycle_holds%rowtype;
  v_status text;
begin
  select * into v_hold from cycle_holds where id = p_hold for update;
  if not found then raise exception 'Hold not found' using errcode = 'P0002'; end if;
  if v_hold.released_at is not null then raise exception 'This hold is already released' using errcode = '23514'; end if;

  update cycle_holds set released_at = now(), released_by = p_admin, release_note = p_note where id = p_hold;

  select status into v_status from settlement_cycles where id = v_hold.cycle_id for update;
  if v_status = 'held' and not exists (select 1 from cycle_holds where cycle_id = v_hold.cycle_id and released_at is null) then
    update settlement_cycles set status = 'open' where id = v_hold.cycle_id;
    v_status := 'open';
  end if;
  return v_status;
end $$;

-- Annule un cycle. Pas encore réglé : il est simplement clos. Déjà réglé : une écriture inverse annule chaque écriture
-- (le journal n'est jamais modifié). Rend le nombre d'écritures inverses.
create or replace function settlement_cancel_cycle(p_cycle uuid, p_admin uuid, p_reason text) returns integer
  language plpgsql as $$
declare
  c settlement_cycles%rowtype;
  v_count integer := 0;
begin
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'A reason of at least 3 characters is required' using errcode = '22023';
  end if;

  select * into c from settlement_cycles where id = p_cycle for update;
  if not found then raise exception 'Settlement cycle not found' using errcode = 'P0002'; end if;
  if c.status = 'cancelled' then raise exception 'This cycle is already cancelled' using errcode = '23514'; end if;

  if c.status = 'settled' then
    insert into ledger_entries (cycle_id, account, artist_id, entry_type, amount_micro, currency, available_at, reverses_entry_id)
    select e.cycle_id, e.account, e.artist_id, 'reversal', -e.amount_micro, e.currency, e.available_at, e.id
      from ledger_entries e
     where e.cycle_id = c.id and e.entry_type = 'credit'
       and not exists (select 1 from ledger_entries r where r.reverses_entry_id = e.id);
    get diagnostics v_count = row_count;
  end if;

  update settlement_cycles
     set status = 'cancelled', cancelled_at = now(), cancelled_by = p_admin, cancel_reason = left(btrim(p_reason), 500)
   where id = c.id;
  return v_count;
end $$;

-- 10. Le passage régulier ---------------------------------------------------------------------------------------------

-- À lancer toutes les heures (étape suivante : tâche pg_cron). Quatre choses, dans cet ordre :
--   0. libère les retenues dont la cause a disparu (frais connus, fraude résolue) ;
--   a. ouvre le cycle de chaque paiement qui n'en a pas (filet de sécurité du webhook, et rattrapage des paiements de test) ;
--   b. règle chaque cycle dont la période est finie ; une erreur sur UN cycle n'arrête pas les autres ;
--   c. retient les crédits d'un cycle réglé, encore « en attente », dont le paiement vient d'être remboursé ou qui est
--      visé par un événement de fraude ouvert.
create or replace function settlement_run(p_now timestamptz default now())
  returns table (opened integer, settled integer, held integer, failed integer, holds_added integer, released integer)
  language plpgsql as $$
declare
  v_opened integer := 0;
  v_settled integer := 0;
  v_held integer := 0;
  v_failed integer := 0;
  v_holds integer := 0;
  v_released integer := 0;
  rec record;
  v_outcome text;
  v_reason text;
  v_detail text;
begin
  for rec in select id from cycle_holds where released_at is null order by created_at loop
    if settlement_hold_cleared(rec.id) then
      perform settlement_release_hold(rec.id, null, 'The cause disappeared: released automatically');
      v_released := v_released + 1;
    end if;
  end loop;

  for rec in
    select p.id from payments p
     where not exists (select 1 from settlement_cycles c where c.payment_id = p.id)
       and p.user_id is not null and p.service_period_start is not null and p.service_period_end > p.service_period_start
       and p.gross_cents - p.tax_cents > 0
     order by p.paid_at
  loop
    if settlement_open_cycle(rec.id) is not null then v_opened := v_opened + 1; end if;
  end loop;

  for rec in select id from settlement_cycles where status = 'open' and period_end <= p_now order by period_end, id loop
    begin
      v_outcome := settlement_settle_cycle(rec.id, p_now);
      if v_outcome = 'settled' then v_settled := v_settled + 1;
      elsif v_outcome = 'held' then v_held := v_held + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'Settlement of cycle % failed: %', rec.id, sqlerrm;
    end;
  end loop;

  for rec in select id from settlement_cycles where status = 'settled' and available_at > p_now loop
    select r.reason, r.detail into v_reason, v_detail from settlement_check_reason(rec.id) r where r.reason in ('refund', 'fraud');
    if v_reason is not null then
      insert into cycle_holds (cycle_id, reason, detail) values (rec.id, v_reason, v_detail)
      on conflict (cycle_id, reason) where (released_at is null) do nothing;
      if found then v_holds := v_holds + 1; end if;
    end if;
    v_reason := null;
  end loop;

  return query select v_opened, v_settled, v_held, v_failed, v_holds, v_released;
end $$;

-- 11. Les soldes ------------------------------------------------------------------------------------------------------

-- Le solde de chaque artiste à un instant donné, calculé depuis le journal. « Disponible » : l'heure de disponibilité est
-- passée ET le cycle n'a aucune retenue active. Tout le reste est « en attente ». Peut être négatif après une écriture
-- inverse sur un crédit déjà disponible (remboursement tardif).
create or replace function artist_balances_at(p_now timestamptz)
  returns table (artist_id uuid, currency text, available_micro bigint, pending_micro bigint)
  language sql stable as $$
  select e.artist_id, e.currency,
         coalesce(sum(e.amount_micro) filter (where e.available_at <= p_now and h.cycle_id is null), 0)::bigint,
         coalesce(sum(e.amount_micro) filter (where e.available_at > p_now or h.cycle_id is not null), 0)::bigint
    from ledger_entries e
    left join (select distinct cycle_id from cycle_holds where released_at is null) h on h.cycle_id = e.cycle_id
   where e.account = 'artist'
   group by e.artist_id, e.currency $$;

create or replace view artist_balances as select * from artist_balances_at(now());

-- 12. Droits ----------------------------------------------------------------------------------------------------------

alter table settlement_rules enable row level security;
alter table settlement_cycles enable row level security;
alter table cycle_holds enable row level security;
alter table cycle_allocations enable row level security;
alter table ledger_entries enable row level security;
revoke all on settlement_rules, settlement_cycles, cycle_holds, cycle_allocations, ledger_entries from anon, authenticated;
revoke all on artist_balances from anon, authenticated;

revoke all on function settlement_open_cycle(uuid) from public, anon, authenticated;
revoke all on function settlement_check_reason(uuid) from public, anon, authenticated;
revoke all on function settlement_cycle_seconds(uuid) from public, anon, authenticated;
revoke all on function settlement_hold_cleared(uuid) from public, anon, authenticated;
revoke all on function settlement_settle_cycle(uuid, timestamptz) from public, anon, authenticated;
revoke all on function settlement_release_hold(uuid, uuid, text) from public, anon, authenticated;
revoke all on function settlement_cancel_cycle(uuid, uuid, text) from public, anon, authenticated;
revoke all on function settlement_run(timestamptz) from public, anon, authenticated;
revoke all on function artist_balances_at(timestamptz) from public, anon, authenticated;
revoke all on function settlement_rules_guard() from public, anon, authenticated;
revoke all on function settlement_cycles_guard() from public, anon, authenticated;
revoke all on function cycle_holds_guard() from public, anon, authenticated;
revoke all on function settlement_append_only() from public, anon, authenticated;
grant execute on function settlement_open_cycle(uuid) to service_role;
grant execute on function settlement_check_reason(uuid) to service_role;
grant execute on function settlement_cycle_seconds(uuid) to service_role;
grant execute on function settlement_hold_cleared(uuid) to service_role;
grant execute on function settlement_settle_cycle(uuid, timestamptz) to service_role;
grant execute on function settlement_release_hold(uuid, uuid, text) to service_role;
grant execute on function settlement_cancel_cycle(uuid, uuid, text) to service_role;
grant execute on function settlement_run(timestamptz) to service_role;
grant execute on function artist_balances_at(timestamptz) to service_role;
grant select on artist_balances to service_role;

notify pgrst, 'reload schema';
