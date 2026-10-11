-- Numérotation permanente du catalogue, anonymisation d'un artiste quand son compte
-- disparaît, noms d'artistes uniques et règles de nom.
-- (docs/SPEC_REMUNERATION.md, décisions D13 à D16, dépôt vynl-app-v1.1.2.)
--
-- 1. NUMÉROS. Chaque artiste, release et morceau reçoit un numéro permanent
--    (`catalog_number`), jamais réutilisé, même si la ligne disparaît : une séquence
--    ne revient pas en arrière. Un « trou » dans la suite est donc normal. Le code
--    affichable (`catalog_code`) en dérive : VYN-A-000007 (artiste), VYN-R-… (release),
--    VYN-T-… (morceau). Immuable : un trigger refuse toute modification.
--
-- 2. ANONYMISATION. Quand un compte est supprimé (ou passé en « deleted »), son
--    artiste devient « Deleted artist VYN-A-… » : nom, bio, images, pays et lien avec
--    le compte disparaissent ; ses morceaux et releases sont archivés ; ses followers
--    et les favoris le concernant sont retirés. Sont CONSERVÉS : tout ce qui sert de
--    pièce comptable ou de preuve (écoutes, royalties, répartitions, déclarations IA
--    et de droits, durée, ISRC, empreinte SHA-256 des fichiers). Les fichiers
--    eux-mêmes (audio, covers, avatar, bannière) sont à supprimer après 30 jours
--    (`purge_after`, script `npm run purge:anonymized`), sauf gel légal (`legal_hold`).
--    Durée de conservation des pièces comptables : 10 ans (art. 958f CO) ; la purge
--    de ces données n'est pas faite ici.
--
-- 3. NOMS. Un nom d'artiste est unique, sans tenir compte des majuscules, des accents,
--    des espaces ni de . - _ ' & ! (« Rafale », « RAFALE », « R.A.F.A.L.E » = le même
--    nom). Longueur 2 à 40, pas de caractère de contrôle ni de < > @ / \, mots réservés.
--    Le nom d'un artiste anonymisé est libéré. Un compte ne peut avoir qu'un artiste.
--
-- Doublon existant : un artiste en double SANS compte, SANS catalogue, SANS écoute et
-- SANS argent est anonymisé automatiquement ; s'il reste un doublon qu'on ne peut pas
-- trancher sans deviner, la migration s'arrête avec la liste, et RIEN n'est modifié
-- (tout est dans une transaction).
--
-- Idempotente (rejouable : les numéros déjà attribués ne changent jamais).
-- Prérequis : 20261009000000_integrity_guards.sql (cycle de vie des morceaux).

begin;

-- =============================================================================
-- 0. Clé de comparaison d'un nom
-- =============================================================================

-- Minuscules, sans accents, sans séparateurs. NFKD sépare les lettres de leurs
-- accents (é -> e + ´) et ramène les formes « larges » à la normale ; on retire
-- ensuite les accents. IMMUTABLE : indispensable pour une colonne calculée.
create or replace function public.artist_name_key(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select regexp_replace(
    lower(regexp_replace(normalize(p_name, nfkd), '[̀-ͯ]', '', 'g')),
    '[ .\-_''&!]+', '', 'g'
  );
$$;

-- =============================================================================
-- 1. Colonnes
-- =============================================================================

alter table public.artists
  add column if not exists name_key text generated always as (public.artist_name_key(name)) stored,
  add column if not exists anonymized_at timestamptz,
  add column if not exists purge_after timestamptz,
  add column if not exists purged_at timestamptz,
  add column if not exists legal_hold boolean not null default false;

alter table public.albums add column if not exists archived_reason text;
alter table public.tracks add column if not exists archived_reason text;
alter table public.track_files add column if not exists purged_at timestamptz;

-- =============================================================================
-- 2. Numéros permanents
-- =============================================================================

create sequence if not exists public.artist_catalog_seq as bigint minvalue 1;
create sequence if not exists public.album_catalog_seq as bigint minvalue 1;
create sequence if not exists public.track_catalog_seq as bigint minvalue 1;

alter table public.artists add column if not exists catalog_number bigint;
alter table public.albums add column if not exists catalog_number bigint;
alter table public.tracks add column if not exists catalog_number bigint;

-- Numérote l'existant dans l'ordre de création, à la suite des numéros déjà
-- attribués, puis avance la séquence sans jamais la faire reculer.
create or replace function pg_temp.number_existing(p_table regclass, p_seq regclass)
returns void
language plpgsql
as $$
declare
  already bigint;
  top bigint;
begin
  execute format('select coalesce(max(catalog_number), 0) from %s', p_table) into already;
  execute format(
    'update %1$s t set catalog_number = r.n + %2$s
       from (select id, row_number() over (order by created_at, id) as n
               from %1$s where catalog_number is null) r
      where t.id = r.id',
    p_table, already
  );
  execute format('select coalesce(max(catalog_number), 0) from %s', p_table) into top;
  if top > 0 and top >= coalesce(pg_sequence_last_value(p_seq), 0) then
    perform setval(p_seq, top, true);
  end if;
end;
$$;

select pg_temp.number_existing('public.artists', 'public.artist_catalog_seq');
select pg_temp.number_existing('public.albums', 'public.album_catalog_seq');
select pg_temp.number_existing('public.tracks', 'public.track_catalog_seq');

alter table public.artists alter column catalog_number set not null;
alter table public.albums alter column catalog_number set not null;
alter table public.tracks alter column catalog_number set not null;

create unique index if not exists artists_catalog_number_key on public.artists (catalog_number);
create unique index if not exists albums_catalog_number_key on public.albums (catalog_number);
create unique index if not exists tracks_catalog_number_key on public.tracks (catalog_number);

-- Code affichable, dérivé du numéro (jamais saisi à la main).
alter table public.artists
  add column if not exists catalog_code text
  generated always as ('VYN-A-' || lpad(catalog_number::text, 6, '0')) stored;
alter table public.albums
  add column if not exists catalog_code text
  generated always as ('VYN-R-' || lpad(catalog_number::text, 6, '0')) stored;
alter table public.tracks
  add column if not exists catalog_code text
  generated always as ('VYN-T-' || lpad(catalog_number::text, 6, '0')) stored;

-- À l'INSERT : le numéro vient TOUJOURS de la séquence (une valeur fournie est
-- ignorée, donc impossible de réutiliser ou de choisir un numéro). Ensuite : immuable.
create or replace function public.catalog_number_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.catalog_number := nextval(tg_argv[0]::regclass);
  elsif new.catalog_number is distinct from old.catalog_number then
    raise exception 'catalog_number is permanent and cannot be changed'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists artists_catalog_number on public.artists;
create trigger artists_catalog_number
  before insert or update on public.artists
  for each row execute function public.catalog_number_guard('public.artist_catalog_seq');

drop trigger if exists albums_catalog_number on public.albums;
create trigger albums_catalog_number
  before insert or update on public.albums
  for each row execute function public.catalog_number_guard('public.album_catalog_seq');

drop trigger if exists tracks_catalog_number on public.tracks;
create trigger tracks_catalog_number
  before insert or update on public.tracks
  for each row execute function public.catalog_number_guard('public.track_catalog_seq');

-- =============================================================================
-- 3. Règles de nom
-- =============================================================================

-- Mots réservés (comparés sur la clé : « V.Y.N.L », « Vynl! » sont donc couverts).
create table if not exists public.reserved_artist_names (
  pattern text primary key check (pattern = lower(pattern) and pattern ~ '^[a-z0-9]+$'),
  match text not null default 'exact' check (match in ('exact', 'prefix')),
  reason text
);
alter table public.reserved_artist_names enable row level security;

insert into public.reserved_artist_names (pattern, match, reason) values
  ('vynl', 'prefix', 'marque'),
  ('deletedartist', 'prefix', 'réservé aux artistes anonymisés'),
  ('admin', 'exact', 'usurpation'), ('administrator', 'exact', 'usurpation'),
  ('support', 'exact', 'usurpation'), ('official', 'exact', 'usurpation'),
  ('staff', 'exact', 'usurpation'), ('team', 'exact', 'usurpation'),
  ('moderator', 'exact', 'usurpation'), ('moderation', 'exact', 'usurpation'),
  ('help', 'exact', 'usurpation'), ('helpdesk', 'exact', 'usurpation'),
  ('system', 'exact', 'usurpation'), ('root', 'exact', 'usurpation'),
  ('verified', 'exact', 'usurpation'), ('security', 'exact', 'usurpation'),
  ('billing', 'exact', 'usurpation'), ('payments', 'exact', 'usurpation'),
  ('royalties', 'exact', 'usurpation'), ('legal', 'exact', 'usurpation'),
  ('press', 'exact', 'usurpation'), ('noreply', 'exact', 'usurpation'),
  ('anonymous', 'exact', 'générique'), ('unknown', 'exact', 'générique'),
  ('null', 'exact', 'technique'), ('undefined', 'exact', 'technique'),
  ('variousartists', 'exact', 'réservé aux compilations'),
  ('label', 'exact', 'générique'), ('labels', 'exact', 'générique'),
  ('artist', 'exact', 'générique'), ('artists', 'exact', 'générique'),
  ('creator', 'exact', 'générique'), ('creators', 'exact', 'générique'),
  ('studio', 'exact', 'générique'), ('owner', 'exact', 'générique')
on conflict (pattern) do nothing;

-- Normalise le nom à l'écriture (espaces multiples -> un seul, bords coupés), puis
-- refuse les mots réservés. Un appel de confiance (anonymisation, administration)
-- lève le contrôle avec : select set_config('vynl.allow_reserved_names', 'on', true);
create or replace function public.artists_name_rules()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  k text;
begin
  new.name := btrim(regexp_replace(new.name, '\s+', ' ', 'g'));

  if tg_op = 'UPDATE' and new.name is not distinct from old.name then
    return new;
  end if;
  if current_setting('vynl.allow_reserved_names', true) = 'on' then
    return new;
  end if;

  k := public.artist_name_key(new.name);
  if exists (
    select 1 from public.reserved_artist_names r
    where (r.match = 'exact' and r.pattern = k)
       or (r.match = 'prefix' and left(k, length(r.pattern)) = r.pattern)
  ) then
    raise exception 'ARTIST_NAME_RESERVED: "%" is a reserved name', new.name
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists artists_name_rules on public.artists;
create trigger artists_name_rules
  before insert or update of name on public.artists
  for each row execute function public.artists_name_rules();

-- Format. NOT VALID : n'examine que les écritures à venir ; on tente ensuite de
-- valider l'existant sans faire échouer la migration si un ancien nom ne convient pas.
alter table public.artists drop constraint if exists artists_name_format;
alter table public.artists add constraint artists_name_format check (
  char_length(name) between 2 and 40
  and name = btrim(name)
  and name !~ '\s{2,}'
  and name !~ '[[:cntrl:]]'
  and name !~ '[<>@/\\]'
  and public.artist_name_key(name) <> ''
) not valid;

do $$
begin
  alter table public.artists validate constraint artists_name_format;
exception when check_violation then
  raise notice 'artists_name_format: certains noms existants ne respectent pas le format ; il ne s''applique qu''aux nouveaux noms.';
end $$;

-- =============================================================================
-- 4. Anonymisation
-- =============================================================================

-- Anonymise un artiste. Retourne false s'il l'était déjà. SECURITY DEFINER : appelée
-- depuis des triggers qui s'exécutent pour le compte d'un rôle quelconque (Supabase
-- Auth, tableau de bord…) ; l'exécution directe est réservée à service_role.
create or replace function public.anonymize_artist(
  p_artist_id uuid,
  p_reason text default 'account_deleted',
  p_grace interval default interval '30 days'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.artists%rowtype;
begin
  select * into a from public.artists where id = p_artist_id for update;
  if not found then
    raise exception 'Artist % not found', p_artist_id using errcode = 'P0002';
  end if;
  if a.anonymized_at is not null then
    return false;
  end if;

  -- « Deleted artist … » appartient aux mots réservés : levée locale, le temps de la transaction.
  perform set_config('vynl.allow_reserved_names', 'on', true);

  update public.artists set
    name = 'Deleted artist ' || a.catalog_code,
    slug = lower('deleted-' || a.catalog_code),
    bio = null,
    avatar_url = null,
    banner_url = null,
    country = null,
    verified = false,
    user_id = null,
    anonymized_at = now(),
    purge_after = now() + p_grace
  where id = a.id;

  update public.tracks
     set status = 'archived', archived_reason = p_reason
   where artist_id = a.id and status <> 'archived';

  update public.albums
     set status = 'archived', archived_reason = p_reason, cover_url = null
   where artist_id = a.id and status <> 'archived';

  -- Données d'auditeurs liées à l'artiste : sans objet une fois l'artiste parti.
  delete from public.follows where artist_id = a.id;
  delete from public.library
   where (item_type = 'artist' and item_id = a.id)
      or (item_type = 'track' and item_id in (select id from public.tracks where artist_id = a.id))
      or (item_type = 'album' and item_id in (select id from public.albums where artist_id = a.id));

  return true;
end;
$$;

revoke all on function public.anonymize_artist(uuid, text, interval) from public, anon, authenticated;
grant execute on function public.anonymize_artist(uuid, text, interval) to service_role;

-- Anonymise les artistes d'un compte. Ne fait JAMAIS échouer la suppression du compte :
-- en cas d'erreur, un avertissement est écrit et l'artiste reste à rattraper avec
-- `npm run purge:anonymized -- --sweep-orphans`.
create or replace function public.anonymize_artists_of_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in select id from public.artists where user_id = p_user_id and anonymized_at is null loop
    begin
      perform public.anonymize_artist(r.id, 'account_deleted');
    exception when others then
      raise warning 'anonymize_artist(%) failed: % (%)', r.id, sqlerrm, sqlstate;
    end;
  end loop;
end;
$$;

revoke all on function public.anonymize_artists_of_user(uuid) from public, anon, authenticated;
grant execute on function public.anonymize_artists_of_user(uuid) to service_role;

-- Suppression réelle du compte (y compris en cascade depuis auth.users).
create or replace function public.users_before_delete_anonymize()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.anonymize_artists_of_user(old.id);
  return old;
end;
$$;

drop trigger if exists users_before_delete_anonymize on public.users;
create trigger users_before_delete_anonymize
  before delete on public.users
  for each row execute function public.users_before_delete_anonymize();

-- Suppression « douce » : le compte passe à « deleted ».
create or replace function public.users_status_deleted_anonymize()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.anonymize_artists_of_user(new.id);
  return new;
end;
$$;

drop trigger if exists users_status_deleted_anonymize on public.users;
create trigger users_status_deleted_anonymize
  after update of status on public.users
  for each row
  when (new.status = 'deleted' and old.status is distinct from 'deleted')
  execute function public.users_status_deleted_anonymize();

-- =============================================================================
-- 5. Doublons existants, avant l'index d'unicité
-- =============================================================================

do $$
declare
  grp record;
  a record;
  kept boolean;
  unresolved text;
begin
  for grp in
    select name_key from public.artists
     where anonymized_at is null
     group by name_key having count(*) > 1
  loop
    kept := false;
    for a in
      select ar.id, ar.user_id,
             (exists (select 1 from public.tracks t where t.artist_id = ar.id)
              or exists (select 1 from public.albums al where al.artist_id = ar.id)
              or exists (select 1 from public.plays p where p.artist_id = ar.id)
              or exists (select 1 from public.royalty_allocations ra where ra.artist_id = ar.id)
              or exists (select 1 from public.splits s where s.artist_id = ar.id)
              or exists (select 1 from public.creator_wallets w
                          where w.artist_id = ar.id and w.balance_cents <> 0)) as has_content
        from public.artists ar
       where ar.name_key = grp.name_key and ar.anonymized_at is null
       order by (ar.user_id is not null) desc, has_content desc, ar.created_at, ar.id
    loop
      if not kept then
        kept := true;            -- celui qu'on garde : compte d'abord, puis catalogue, puis le plus ancien
      elsif a.user_id is null and not a.has_content then
        perform public.anonymize_artist(a.id, 'duplicate_name');
      end if;
    end loop;
  end loop;

  -- Reste-t-il un doublon qu'on ne peut pas trancher sans deviner ?
  select string_agg(g, ', ') into unresolved
    from (
      select format('"%s" x%s', min(name), count(*)) as g
        from public.artists
       where anonymized_at is null
       group by name_key having count(*) > 1
    ) x;

  if unresolved is not null then
    raise exception 'Duplicate artist names remain and need a human decision: %', unresolved
      using hint = 'Each duplicate has an account or a catalogue. Rename or merge one by hand, then re-run.';
  end if;
end $$;

-- Un slug en « nom-xxxx » dû à un ancien doublon redevient « nom » quand c'est libre.
do $$
declare
  a record;
  base text;
begin
  for a in select id, name, slug from public.artists where anonymized_at is null loop
    base := left(
      regexp_replace(
        regexp_replace(
          lower(regexp_replace(normalize(a.name, nfkd), '[̀-ͯ]', '', 'g')),
          '[^a-z0-9]+', '-', 'g'),
        '^-+|-+$', '', 'g'),
      80);
    if base <> '' and a.slug <> base and a.slug ~ ('^' || base || '-[a-z0-9]{4}$')
       and not exists (select 1 from public.artists where slug = base) then
      update public.artists set slug = base where id = a.id;
    end if;
  end loop;
end $$;

-- =============================================================================
-- 6. Unicité (garantie par la base, donc à l'épreuve des créations simultanées)
-- =============================================================================

create unique index if not exists artists_name_key_unique
  on public.artists (name_key) where anonymized_at is null;

create unique index if not exists artists_user_id_unique
  on public.artists (user_id) where user_id is not null;

-- =============================================================================
-- 7. Disponibilité d'un nom (pour l'API)
-- =============================================================================

-- 'ok' | 'taken' | 'reserved' | 'invalid'. Le format détaillé (caractères autorisés…)
-- est contrôlé côté API pour donner un message précis ; ici, le strict nécessaire.
create or replace function public.artist_name_status(p_name text, p_exclude_artist uuid default null)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  k text := public.artist_name_key(n);
begin
  if char_length(n) not between 2 and 40 or k = '' then
    return 'invalid';
  end if;
  if exists (
    select 1 from public.reserved_artist_names r
    where (r.match = 'exact' and r.pattern = k)
       or (r.match = 'prefix' and left(k, length(r.pattern)) = r.pattern)
  ) then
    return 'reserved';
  end if;
  if exists (
    select 1 from public.artists
     where name_key = k and anonymized_at is null
       and (p_exclude_artist is null or id <> p_exclude_artist)
  ) then
    return 'taken';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.artist_name_status(text, uuid) from public, anon, authenticated;
grant execute on function public.artist_name_status(text, uuid) to service_role;

commit;
