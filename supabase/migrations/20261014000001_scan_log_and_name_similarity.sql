-- Contrôles de contenu de la bêta (docs/SPEC_REMUNERATION.md, section 15.5, étape 9a) :
--
-- 1. track_scans : le JOURNAL de chaque contrôle fait sur un morceau ou un artiste (empreinte de
--    fichier, ressemblance de nom, et plus tard prestataire d'empreintes acoustiques, détecteur IA).
--    C'est la preuve de diligence (« meilleurs efforts », art. 17 de la directive 2019/790 ; mesures
--    « raisonnables », art. 39d LDA) : on y garde qui a été contrôlé, quand, par quoi, avec quel
--    résultat, et la décision humaine. Un résultat ne se modifie jamais ; seule la décision d'un
--    administrateur s'ajoute, une seule fois. Jamais de donnée personnelle dans `detail`.
--
-- 2. similar_artist_names() : les noms d'artistes qui RESSEMBLENT à un nom (pas identiques : l'unicité
--    est déjà contrôlée par artist_name_status). Similarité de trigrammes (pg_trgm) sur la clé du nom
--    (minuscules, sans accents ni séparateurs) : « Daftpunk » ~ « Dafft Punk », « The Weeknd » ~ « Weeknd ».
--    Seuil 0,55 : calibré sur des paires réalistes (vraies ressemblances ≥ 0,60, noms distincts ≤ 0,50).
--
-- 3. Un index sur l'empreinte SHA-256 des fichiers audio, pour repérer le MÊME fichier envoyé par un autre
--    artiste sans parcourir toute la table.
--
-- Idempotente (rejouable). Prérequis : 20261011000000_catalog_numbers_and_artist_names.sql.
-- À appliquer dans le SQL Editor de Supabase. Sans elle, l'API continue de fonctionner : le journal et la
-- ressemblance sont simplement absents (l'API ne bloque rien si la table ou la fonction manque).

-- Les extensions de Supabase vivent dans le schéma « extensions » : on le met dans le chemin de recherche
-- de cette session pour que pg_trgm (opérateur « % », classe d'index gin_trgm_ops) soit trouvé partout.
set search_path to public, extensions;

-- =============================================================================
-- 1. Journal des contrôles
-- =============================================================================

create table if not exists track_scans (
  id                uuid primary key default gen_random_uuid(),
  -- Ce qui a été contrôlé : un morceau (et son fichier), ou un artiste (nom).
  track_id          uuid references tracks(id) on delete set null,
  track_file_id     uuid references track_files(id) on delete set null,
  artist_id         uuid references artists(id) on delete set null,
  -- file_hash, name_similarity, fingerprint, ai_detector… (texte : une nouvelle sorte de contrôle ne
  -- demande pas de migration).
  check_kind        text not null check (check_kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  provider          text not null default 'internal' check (length(provider) between 1 and 60),
  provider_version  text,
  -- ok : rien à signaler ; warn : à relire ; fail : bloqué.
  result            text not null check (result in ('ok', 'warn', 'fail')),
  score             numeric,
  -- La correspondance trouvée (morceau ou artiste existant). Jamais montrée à l'artiste contrôlé.
  matched_track_id  uuid references tracks(id) on delete set null,
  matched_artist_id uuid references artists(id) on delete set null,
  detail            jsonb not null default '{}'::jsonb,
  -- Décision humaine (une seule fois) : confirmée (vrai problème) ou écartée (fausse alerte).
  decision          text check (decision in ('confirmed', 'dismissed')),
  decided_by        uuid references users(id) on delete set null,
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz not null default now(),
  constraint track_scans_decision_complete check ((decision is null) = (decided_at is null))
);

create index if not exists idx_track_scans_track on track_scans (track_id, created_at desc);
create index if not exists idx_track_scans_artist on track_scans (artist_id, created_at desc);
create index if not exists idx_track_scans_open on track_scans (created_at desc) where result <> 'ok' and decision is null;

alter table track_scans enable row level security;

-- Pièce de preuve : jamais supprimée ; un résultat ne change plus. Les références vers un morceau, un
-- artiste ou un compte supprimé passent à null (c'est la base qui le fait), jamais vers autre chose.
-- La décision humaine s'ajoute une fois.
create or replace function track_scans_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'scan records cannot be deleted' using errcode = '23514';
  end if;

  if new.check_kind is distinct from old.check_kind
     or new.provider is distinct from old.provider
     or new.provider_version is distinct from old.provider_version
     or new.result is distinct from old.result
     or new.score is distinct from old.score
     or new.detail is distinct from old.detail
     or new.created_at is distinct from old.created_at then
    raise exception 'The result of a scan cannot be modified' using errcode = '23514';
  end if;

  if (new.track_id is distinct from old.track_id and new.track_id is not null)
     or (new.track_file_id is distinct from old.track_file_id and new.track_file_id is not null)
     or (new.artist_id is distinct from old.artist_id and new.artist_id is not null)
     or (new.matched_track_id is distinct from old.matched_track_id and new.matched_track_id is not null)
     or (new.matched_artist_id is distinct from old.matched_artist_id and new.matched_artist_id is not null) then
    raise exception 'A scan cannot be reassigned to another subject' using errcode = '23514';
  end if;

  if old.decision is not null
     and (new.decision is distinct from old.decision
          or new.decided_at is distinct from old.decided_at
          or new.decision_note is distinct from old.decision_note
          or (new.decided_by is distinct from old.decided_by and new.decided_by is not null)) then
    raise exception 'The decision on a scan can only be set once' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists track_scans_guard on track_scans;
create trigger track_scans_guard before update or delete on track_scans for each row execute function track_scans_guard();

-- =============================================================================
-- 2. Noms d'artistes qui se ressemblent
-- =============================================================================

create extension if not exists pg_trgm with schema extensions;

-- name_key : calculée par artist_name_key (migration précédente). L'index accélère l'opérateur « % ».
create index if not exists idx_artists_name_key_trgm on artists using gin (name_key gin_trgm_ops);

-- Les artistes dont le nom RESSEMBLE à p_name (similarité >= 0,55, ou l'un contient l'autre quand le plus
-- court a au moins 5 caractères), sans l'artiste exclu ni les comptes anonymisés, et SANS le nom identique
-- (déjà refusé ailleurs). Les plus proches d'abord, 5 au plus.
create or replace function public.similar_artist_names(p_name text, p_exclude_artist uuid default null)
returns table (artist_id uuid, name text, similarity real)
language sql
stable
set search_path = public, extensions
as $$
  with q as (select public.artist_name_key(p_name) as k)
  select a.id, a.name, similarity(a.name_key, q.k)
  from artists a, q
  where char_length(q.k) >= 3
    and a.anonymized_at is null
    and a.name_key <> q.k
    and (p_exclude_artist is null or a.id <> p_exclude_artist)
    and (
      (a.name_key % q.k and similarity(a.name_key, q.k) >= 0.55)
      or (least(char_length(a.name_key), char_length(q.k)) >= 5
          and (position(q.k in a.name_key) > 0 or position(a.name_key in q.k) > 0))
    )
  order by similarity(a.name_key, q.k) desc, a.name
  limit 5;
$$;

revoke all on function public.similar_artist_names(text, uuid) from public, anon, authenticated;
grant execute on function public.similar_artist_names(text, uuid) to service_role;

-- =============================================================================
-- 3. Empreinte des fichiers audio
-- =============================================================================

create index if not exists idx_track_files_checksum on track_files (checksum) where checksum is not null;

-- Demande à l'API de Supabase (PostgREST) de relire le schéma.
notify pgrst, 'reload schema';

-- =============================================================================
-- Vérification après application (à lancer à la main) :
--
--   select count(*) from track_scans;                                  -- 0 au départ
--   select * from similar_artist_names('Un Nom D''Essai');              -- 0 ligne, ou des noms proches
--   select indexname from pg_indexes where tablename in ('track_scans', 'artists', 'track_files')
--     and indexname like 'idx_%' order by 1;
-- =============================================================================
