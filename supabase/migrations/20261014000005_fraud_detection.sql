-- Détection de fraude à l'écoute, première version (docs/SPEC_REMUNERATION.md, 6.3 et étape 10).
--
-- Jusqu'ici la page « Fraud » de l'admin lisait deux tables que RIEN n'écrivait. Cette migration ajoute :
--
-- 1. fraud_detect()            : six règles qui regardent les écoutes (`plays`) JOUR PAR JOUR (jours UTC) et
--                                écrivent des ÉVÉNEMENTS (`fraud_events`), puis recalculent un score par compte
--                                (`fraud_scores`). Elle SIGNALE, elle n'exclut rien : c'est un administrateur qui
--                                décide, événement par événement. Rejouable sans danger : un même événement (même
--                                règle, même jour, même sujet) n'est écrit qu'une fois.
-- 2. fraud_event_plays()       : les écoutes visées par un événement (même logique pour l'aperçu et l'exclusion).
-- 3. fraud_exclude_event_plays(): exclut ces écoutes (`counted = false`, avec le motif ; jamais supprimées, spec 6.3).
--
-- Les règles (seuils choisis pour ne signaler que ce qu'une personne n'a guère de raison de faire ; ils se règlent
-- ici, par une nouvelle migration, une fois qu'on aura vu de vraies données) :
--
--   round_the_clock       un compte écoute 18 h validées ou plus dans la journée (22 h : haute gravité).
--   track_repetition      un compte écoute 40 fois ou plus le même morceau dans la journée (100 : moyenne, 300 : haute).
--   qualification_farming un compte fait 50 écoutes ou plus qui s'arrêtent juste après les 30 s qui comptent
--                         (morceaux de 90 s et plus), et ce sont 80 % ou plus de ses écoutes qualifiées du jour
--                         (150 écoutes : haute gravité).
--   new_account_burst     un morceau reçoit 20 écoutes ou plus dans la journée, de 10 comptes distincts ou plus, dont
--                         80 % ou plus viennent de comptes créés dans les 7 jours (100 écoutes : haute gravité).
--   shared_ip_fingerprint une même empreinte d'IP du jour (salée, rotative) sert 4 comptes ou plus, 40 écoutes ou plus,
--                         dont 60 % ou plus sur le même artiste (10 comptes : haute gravité).
--   many_countries        un compte écoute depuis 4 pays ou plus dans la journée (7 : moyenne) : partage de compte ou relais.
--
-- Par défaut seules les journées COMPLÈTES sont examinées (les trois derniers jours avant aujourd'hui) : les chiffres
-- d'une journée en cours ne sont pas définitifs. Les pays, appareils et empreintes d'IP sont ceux que l'app auditeur
-- transmet ; sans eux les règles qui en dépendent ne voient rien (jamais de faux signal).
--
-- Sécurité : exécution réservée à service_role (la clé secrète de l'admin), jamais à anon / authenticated.
-- Planifier la détection : voir la fin du fichier (volontaire, rien ne tourne tout seul).
--
-- Idempotente (rejouable). Prérequis : le schéma initial (fraud_events, fraud_scores), 20261009000002_plays.sql.

-- =============================================================================
-- 1. Clé d'unicité des événements
-- =============================================================================

alter table fraud_events add column if not exists dedupe_key text;

-- Une règle, un jour, un sujet : un seul événement (les événements saisis à la main n'ont pas de clé).
create unique index if not exists idx_fraud_events_dedupe on fraud_events (event_type, dedupe_key) where dedupe_key is not null;
create index if not exists idx_fraud_events_open on fraud_events (detected_at desc) where not resolved;

-- =============================================================================
-- 2. La détection
-- =============================================================================

-- Les écoutes COMPTÉES d'une fenêtre (une écoute déjà exclue n'est pas resignalée), avec leur jour UTC. Une fonction
-- plutôt qu'une table temporaire : rien à créer ni à nettoyer à chaque appel.
create or replace function fraud_plays_in_window(p_since timestamptz, p_until timestamptz)
returns table (
  id uuid, user_id uuid, track_id uuid, artist_id uuid, started_at timestamptz, day date,
  validated_seconds numeric, qualified boolean, track_duration_seconds integer, country_code text, ip_hash text
)
language sql
stable
set search_path = public
as $$
  select p.id, p.user_id, p.track_id, p.artist_id, p.started_at, (p.started_at at time zone 'UTC')::date,
         coalesce(p.validated_seconds, 0), p.qualified, p.track_duration_seconds, p.country_code, p.ip_hash
  from plays p
  where p.counted and p.started_at >= p_since and p.started_at < p_until;
$$;

create or replace function fraud_detect(
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns table (rule text, created bigint)
language plpgsql
set search_path = public
as $$
declare
  v_today timestamptz := (date_trunc('day', now() at time zone 'UTC')) at time zone 'UTC';
  v_since timestamptz := (date_trunc('day', coalesce(p_since, v_today - interval '3 days') at time zone 'UTC')) at time zone 'UTC';
  v_until timestamptz := coalesce(p_until, v_today);
  v_n bigint;
begin
  if v_until <= v_since then
    return;
  end if;

  -- 1. Écoute quasi ininterrompue.
  with w as materialized (select * from fraud_plays_in_window(v_since, v_until))
  insert into fraud_events (user_id, event_type, severity, details, dedupe_key)
  select g.user_id, 'round_the_clock',
         case when g.seconds >= 22 * 3600 then 'high' else 'medium' end,
         jsonb_build_object('day', g.day, 'validated_seconds', round(g.seconds), 'hours', round(g.seconds / 3600, 1),
                            'plays', g.n, 'window_start', g.day::timestamp at time zone 'UTC',
                            'window_end', (g.day + 1)::timestamp at time zone 'UTC'),
         g.day::text || ':user:' || g.user_id
  from (select user_id, day, sum(validated_seconds) as seconds, count(*) as n
        from w where user_id is not null group by user_id, day
        having sum(validated_seconds) >= 18 * 3600) g
  on conflict (event_type, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  rule := 'round_the_clock'; created := v_n; return next;

  -- 2. Le même morceau, encore et encore.
  with w as materialized (select * from fraud_plays_in_window(v_since, v_until))
  insert into fraud_events (user_id, track_id, event_type, severity, details, dedupe_key)
  select g.user_id, g.track_id, 'track_repetition',
         case when g.n >= 300 then 'high' when g.n >= 100 then 'medium' else 'low' end,
         jsonb_build_object('day', g.day, 'plays', g.n, 'window_start', g.day::timestamp at time zone 'UTC',
                            'window_end', (g.day + 1)::timestamp at time zone 'UTC'),
         g.day::text || ':user:' || g.user_id || ':track:' || g.track_id
  from (select user_id, track_id, day, count(*) as n
        from w where user_id is not null and qualified group by user_id, track_id, day
        having count(*) >= 40) g
  on conflict (event_type, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  rule := 'track_repetition'; created := v_n; return next;

  -- 3. Écoutes qui s'arrêtent juste après le seuil des 30 s.
  with w as materialized (select * from fraud_plays_in_window(v_since, v_until))
  insert into fraud_events (user_id, event_type, severity, details, dedupe_key)
  select g.user_id, 'qualification_farming',
         case when g.just >= 150 then 'high' else 'medium' end,
         jsonb_build_object('day', g.day, 'just_qualified_plays', g.just, 'qualified_plays', g.total,
                            'share', round(g.just::numeric / g.total, 2), 'window_start', g.day::timestamp at time zone 'UTC',
                            'window_end', (g.day + 1)::timestamp at time zone 'UTC'),
         g.day::text || ':user:' || g.user_id
  from (select user_id, day,
               count(*) filter (where track_duration_seconds >= 90 and validated_seconds < 35) as just,
               count(*) as total
        from w where user_id is not null and qualified group by user_id, day) g
  where g.just >= 50 and g.just::numeric / g.total >= 0.8
  on conflict (event_type, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  rule := 'qualification_farming'; created := v_n; return next;

  -- 4. Un morceau porté par des comptes tout neufs.
  with w as materialized (select * from fraud_plays_in_window(v_since, v_until))
  insert into fraud_events (track_id, event_type, severity, details, dedupe_key)
  select g.track_id, 'new_account_burst',
         case when g.n >= 100 then 'high' else 'medium' end,
         jsonb_build_object('day', g.day, 'plays', g.n, 'accounts', g.accounts,
                            'new_account_share', round(g.fresh::numeric / g.n, 2),
                            'window_start', g.day::timestamp at time zone 'UTC',
                            'window_end', (g.day + 1)::timestamp at time zone 'UTC'),
         g.day::text || ':track:' || g.track_id
  from (select p.track_id, p.day, count(*) as n, count(distinct p.user_id) as accounts,
               count(*) filter (where u.created_at >= p.started_at - interval '7 days') as fresh
        from w p join users u on u.id = p.user_id
        where p.qualified group by p.track_id, p.day) g
  where g.n >= 20 and g.accounts >= 10 and g.fresh::numeric / g.n >= 0.8
  on conflict (event_type, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  rule := 'new_account_burst'; created := v_n; return next;

  -- 5. Plusieurs comptes derrière la même empreinte d'IP, tous sur le même artiste.
  with w as materialized (select * from fraud_plays_in_window(v_since, v_until))
  insert into fraud_events (event_type, severity, details, dedupe_key)
  select 'shared_ip_fingerprint',
         case when g.accounts >= 10 then 'high' else 'medium' end,
         jsonb_build_object('day', g.day, 'ip_hash', g.ip_hash, 'accounts', g.accounts, 'plays', g.n,
                            'top_artist_share', round(g.top::numeric / g.n, 2), 'top_artist_id', g.top_artist,
                            'user_ids', to_jsonb(g.users[1:20]), 'window_start', g.day::timestamp at time zone 'UTC',
                            'window_end', (g.day + 1)::timestamp at time zone 'UTC'),
         g.day::text || ':ip:' || g.ip_hash
  from (
    select s.ip_hash, s.day, s.n, s.accounts, s.users, t.artist_id as top_artist, t.n as top
    from (select ip_hash, day, count(*) as n, count(distinct user_id) as accounts,
                 array_agg(distinct user_id) as users
          from w where ip_hash is not null and user_id is not null and qualified
          group by ip_hash, day) s
    join lateral (select artist_id, count(*) as n from w f
                  where f.ip_hash = s.ip_hash and f.day = s.day and f.qualified
                  group by artist_id order by count(*) desc, artist_id limit 1) t on true
  ) g
  where g.accounts >= 4 and g.n >= 40 and g.top::numeric / g.n >= 0.6
  on conflict (event_type, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  rule := 'shared_ip_fingerprint'; created := v_n; return next;

  -- 6. Beaucoup de pays dans la journée.
  with w as materialized (select * from fraud_plays_in_window(v_since, v_until))
  insert into fraud_events (user_id, event_type, severity, details, dedupe_key)
  select g.user_id, 'many_countries',
         case when g.countries >= 7 then 'medium' else 'low' end,
         jsonb_build_object('day', g.day, 'countries', g.countries, 'country_codes', to_jsonb(g.codes),
                            'window_start', g.day::timestamp at time zone 'UTC',
                            'window_end', (g.day + 1)::timestamp at time zone 'UTC'),
         g.day::text || ':user:' || g.user_id
  from (select user_id, day, count(distinct country_code) as countries, array_agg(distinct country_code) as codes
        from w where user_id is not null and country_code is not null group by user_id, day
        having count(distinct country_code) >= 4) g
  on conflict (event_type, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  rule := 'many_countries'; created := v_n; return next;

  -- Score par compte : la somme des gravités de ses événements OUVERTS des 30 derniers jours, plafonnée à 100
  -- (faible 5, moyenne 15, haute 40, critique 80). On remplace tous les scores de comptes : ils ne viennent que d'ici.
  delete from fraud_scores where subject_type = 'user';
  insert into fraud_scores (subject_type, subject_id, score, factors, computed_at)
  select 'user', u.user_id, least(100, u.points), jsonb_build_object('open_events', u.events, 'by_type', u.by_type), now()
  from (
    select user_id, sum(points) as points, sum(n) as events, jsonb_object_agg(event_type, n) as by_type
    from (select user_id, event_type, count(*) as n,
                 sum(case severity when 'low' then 5 when 'medium' then 15 when 'high' then 40 when 'critical' then 80 else 5 end) as points
          from fraud_events
          where user_id is not null and not resolved and detected_at >= now() - interval '30 days'
          group by user_id, event_type) e
    group by user_id
  ) u;
  get diagnostics v_n = row_count;
  rule := 'scores_refreshed'; created := v_n; return next;

end;
$$;

-- =============================================================================
-- 3. Les écoutes visées par un événement, et leur exclusion
-- =============================================================================

-- Les écoutes COMPTÉES derrière un événement détecté. Un type sans portée claire (many_countries, événement saisi
-- à la main) ne vise aucune écoute : on n'exclut jamais « au jugé ».
create or replace function fraud_event_plays(p_event_id uuid)
returns table (play_id uuid)
language plpgsql
stable
set search_path = public
as $$
declare
  e fraud_events%rowtype;
  v_start timestamptz;
  v_end timestamptz;
begin
  select * into e from fraud_events where id = p_event_id;
  if not found then
    return;
  end if;
  v_start := (e.details ->> 'window_start')::timestamptz;
  v_end := (e.details ->> 'window_end')::timestamptz;
  if v_start is null or v_end is null then
    return;
  end if;

  if e.event_type = 'round_the_clock' and e.user_id is not null then
    return query select p.id from plays p
      where p.counted and p.user_id = e.user_id and p.started_at >= v_start and p.started_at < v_end;

  elsif e.event_type = 'track_repetition' and e.user_id is not null and e.track_id is not null then
    return query select p.id from plays p
      where p.counted and p.user_id = e.user_id and p.track_id = e.track_id
        and p.started_at >= v_start and p.started_at < v_end;

  elsif e.event_type = 'qualification_farming' and e.user_id is not null then
    return query select p.id from plays p
      where p.counted and p.user_id = e.user_id and p.qualified
        and p.track_duration_seconds >= 90 and coalesce(p.validated_seconds, 0) < 35
        and p.started_at >= v_start and p.started_at < v_end;

  elsif e.event_type = 'new_account_burst' and e.track_id is not null then
    return query select p.id from plays p join users u on u.id = p.user_id
      where p.counted and p.track_id = e.track_id and p.qualified
        and u.created_at >= p.started_at - interval '7 days'
        and p.started_at >= v_start and p.started_at < v_end;

  elsif e.event_type = 'shared_ip_fingerprint' and (e.details ->> 'ip_hash') is not null then
    return query select p.id from plays p
      where p.counted and p.ip_hash = e.details ->> 'ip_hash'
        and p.started_at >= v_start and p.started_at < v_end;
  end if;
end;
$$;

-- Exclut ces écoutes : counted = false et le motif (jamais supprimées). Rend le nombre d'écoutes exclues et le
-- note dans l'événement. L'appelant (l'admin) vérifie avant que la période n'est pas figée.
create or replace function fraud_exclude_event_plays(p_event_id uuid, p_reason text)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  v_n bigint;
begin
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'A reason of at least 3 characters is required' using errcode = '22023';
  end if;

  update plays set counted = false, excluded_reason = p_reason
  where counted and id in (select play_id from fraud_event_plays(p_event_id));
  get diagnostics v_n = row_count;

  -- On CUMULE : un deuxième appel qui n'exclut plus rien (0) ne doit pas effacer ce que le premier a noté.
  if v_n > 0 then
    update fraud_events
       set details = coalesce(details, '{}'::jsonb)
                     || jsonb_build_object('excluded_plays', coalesce((details ->> 'excluded_plays')::bigint, 0) + v_n,
                                           'excluded_at', now())
     where id = p_event_id;
  end if;
  return v_n;
end;
$$;

revoke all on function fraud_plays_in_window(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function fraud_detect(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function fraud_event_plays(uuid) from public, anon, authenticated;
revoke all on function fraud_exclude_event_plays(uuid, text) from public, anon, authenticated;
grant execute on function fraud_plays_in_window(timestamptz, timestamptz) to service_role;
grant execute on function fraud_detect(timestamptz, timestamptz) to service_role;
grant execute on function fraud_event_plays(uuid) to service_role;
grant execute on function fraud_exclude_event_plays(uuid, text) to service_role;

-- Demande à l'API de Supabase (PostgREST) de relire le schéma.
notify pgrst, 'reload schema';

-- =============================================================================
-- Planifier la détection (OPTIONNEL, à faire à part) :
--
--   1. Supabase > Database > Extensions : activer « pg_cron » (déjà fait si la purge est planifiée).
--   2. Essayer d'abord à la main : select * from fraud_detect();   -- les 3 derniers jours complets
--   3. Puis : select cron.schedule('vynl-fraud-detect', '30 3 * * *', $$ select * from fraud_detect() $$);
--      (tous les jours à 03:30 UTC). Pour l'arrêter : select cron.unschedule('vynl-fraud-detect');
--
-- Vérification après application (à lancer à la main) :
--   select * from fraud_detect();      -- une ligne par règle (0 au départ), plus « scores_refreshed »
-- =============================================================================
