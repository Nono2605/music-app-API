-- Versions AAC des morceaux pour le CDN (cdn.vynl.li) : la table des versions, la file de transcodage, la file de
-- suppression des fichiers du CDN, et les fonctions que le worker de transcodage appelle.
--
-- Principe : le fichier ORIGINAL reste dans Supabase (track_files, bucket « track-audio »), intact. Un worker en tire
-- deux versions AAC (128 et 256 kbit/s, démarrage rapide) qu'il dépose dans le bucket R2 « vynlmusic ». POST /plays rend
-- l'adresse du CDN quand une version existe, et celle de Supabase sinon : rien ne casse tant que le CDN n'est pas prêt.
--
-- Ce que fait cette migration :
--   1. track_renditions        une ligne par version prête (clé R2, débit, taille, durée) ;
--   2. transcode_jobs          une ligne par fichier original à transcoder, avec un bail (verrou à durée limitée) :
--                              un worker planté ne bloque rien, la tâche est reprise ;
--   3. cdn_object_deletions    les fichiers du CDN à supprimer. Un déclencheur y inscrit la clé de chaque version
--                              supprimée, quelle qu'en soit la cause (fichier retiré, morceau ou release supprimé,
--                              artiste purgé) : le worker vide cette file, aucun fichier orphelin ne reste sur R2 ;
--   4. un déclencheur sur track_files : tout nouveau fichier crée sa tâche de transcodage ;
--   5. le rattrapage : une tâche pour chaque fichier déjà présent ;
--   6. claim_transcode_job / finish_transcode_job / fail_transcode_job (clé secrète seulement) ;
--   7. admin_transcode_status() : l'état en un coup d'œil, pour la page « System » de l'admin.
--
-- Prérequis : 20261009000000 (track_files.verified_at) et 20261011000000 (track_files.purged_at). Idempotente.

-- 1. Les versions prêtes ----------------------------------------------------------------------------------------------

create table if not exists track_renditions (
  id               uuid primary key default gen_random_uuid(),
  track_id         uuid not null references tracks(id) on delete cascade,
  source_file_id   uuid not null references track_files(id) on delete cascade,
  codec            text not null default 'aac',
  bitrate_kbps     integer not null check (bitrate_kbps > 0),
  storage_provider text not null default 'r2',
  storage_key      text not null,
  file_size_bytes  bigint not null check (file_size_bytes > 0),
  duration_seconds integer check (duration_seconds is null or duration_seconds > 0),
  created_at       timestamptz not null default now(),
  constraint track_renditions_one_per_bitrate unique (source_file_id, bitrate_kbps),
  constraint track_renditions_key_unique unique (storage_key)
);
create index if not exists idx_track_renditions_track_id on track_renditions(track_id);

-- 2. La file de transcodage -------------------------------------------------------------------------------------------

create table if not exists transcode_jobs (
  id             uuid primary key default gen_random_uuid(),
  source_file_id uuid not null unique references track_files(id) on delete cascade,
  status         text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts       integer not null default 0,
  locked_by      text,
  -- « queued » : pas avant cette date (attente entre deux essais). « running » : fin du bail.
  locked_until   timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists idx_transcode_jobs_open on transcode_jobs(created_at) where status in ('queued', 'running');

-- 3. La file de suppression des fichiers du CDN (les déclencheurs de cette migration s'exécutent avec les droits de leur
--    propriétaire : un utilisateur qui supprime un morceau n'a pas besoin d'accéder à ces tables) -----------------------------------------------------------------------

create table if not exists cdn_object_deletions (
  id          bigint generated always as identity primary key,
  storage_key text not null,
  created_at  timestamptz not null default now(),
  attempts    integer not null default 0,
  last_error  text
);

create or replace function track_rendition_deleted() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into cdn_object_deletions (storage_key) values (old.storage_key);
  return old;
end $$;

drop trigger if exists track_renditions_deleted on track_renditions;
create trigger track_renditions_deleted after delete on track_renditions
  for each row execute function track_rendition_deleted();

-- 4. Un nouveau fichier crée sa tâche ; un fichier purgé perd ses versions et sa tâche --------------------------------

create or replace function track_file_enqueue_transcode() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.purged_at is null and new.storage_provider = 'supabase' then
    insert into transcode_jobs (source_file_id) values (new.id) on conflict (source_file_id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists track_files_enqueue_transcode on track_files;
create trigger track_files_enqueue_transcode after insert on track_files
  for each row execute function track_file_enqueue_transcode();

create or replace function track_file_purged() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.purged_at is not null and old.purged_at is null then
    -- Supprimer les versions inscrit leurs clés dans cdn_object_deletions (déclencheur ci-dessus).
    delete from track_renditions where source_file_id = new.id;
    delete from transcode_jobs where source_file_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists track_files_purged on track_files;
create trigger track_files_purged after update of purged_at on track_files
  for each row execute function track_file_purged();

-- 5. Rattrapage : une tâche pour chaque fichier déjà là (sans doublon, rejouable) -------------------------------------

insert into transcode_jobs (source_file_id)
select id from track_files where purged_at is null and storage_provider = 'supabase'
on conflict (source_file_id) do nothing;

-- 6. Les fonctions du worker ------------------------------------------------------------------------------------------

-- Prend la plus ancienne tâche disponible : en attente (et dont l'attente est finie) ou « running » dont le bail est
-- échu (worker planté). `for update skip locked` : deux workers ne prennent jamais la même. Une tâche qui a épuisé ses
-- essais passe en « failed » au lieu d'être reprise sans fin.
create or replace function claim_transcode_job(p_worker text, p_lease_seconds integer default 900, p_max_attempts integer default 3)
  returns table (job_id uuid, source_file_id uuid, track_id uuid, storage_key text, attempts integer)
  language plpgsql as $$
declare
  v_id uuid;
begin
  update transcode_jobs
     set status = 'failed', locked_by = null, finished_at = now(), updated_at = now(),
         last_error = coalesce(last_error, 'bail échu après le dernier essai')
   where status = 'running' and locked_until < now() and transcode_jobs.attempts >= p_max_attempts;

  select j.id into v_id
    from transcode_jobs j
   where j.status in ('queued', 'running')
     and coalesce(j.locked_until, '-infinity'::timestamptz) < now()
     and j.attempts < p_max_attempts
   order by j.created_at
   for update skip locked
   limit 1;
  if v_id is null then return; end if;

  update transcode_jobs j
     set status = 'running', attempts = j.attempts + 1, locked_by = p_worker, updated_at = now(),
         locked_until = now() + make_interval(secs => p_lease_seconds)
   where j.id = v_id;

  return query
    select j.id, j.source_file_id, f.track_id, f.storage_key, j.attempts
      from transcode_jobs j join track_files f on f.id = j.source_file_id
     where j.id = v_id;
end $$;

-- Marque la tâche terminée, seulement par le worker qui la détient (un bail repris par un autre ne se termine pas).
create or replace function finish_transcode_job(p_job uuid, p_worker text) returns boolean
  language plpgsql as $$
declare
  v_rows integer;
begin
  update transcode_jobs
     set status = 'done', locked_by = null, locked_until = null, last_error = null, finished_at = now(), updated_at = now()
   where id = p_job and status = 'running' and locked_by = p_worker;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end $$;

-- Un essai a échoué : on rend la tâche après une attente, ou on l'abandonne (« failed ») quand les essais sont épuisés.
create or replace function fail_transcode_job(p_job uuid, p_worker text, p_error text, p_retry_after_seconds integer default 300, p_max_attempts integer default 3)
  returns text
  language plpgsql as $$
declare
  v_attempts integer;
  v_status text;
begin
  select attempts into v_attempts from transcode_jobs where id = p_job and status = 'running' and locked_by = p_worker for update;
  if not found then return 'ignored'; end if;

  v_status := case when v_attempts >= p_max_attempts then 'failed' else 'queued' end;
  update transcode_jobs
     set status = v_status, locked_by = null, updated_at = now(), last_error = left(coalesce(p_error, 'erreur inconnue'), 1000),
         locked_until = case when v_status = 'queued' then now() + make_interval(secs => p_retry_after_seconds) else null end,
         finished_at = case when v_status = 'failed' then now() else null end
   where id = p_job;
  return v_status;
end $$;

-- Remet une tâche « failed » (ou « done ») en file, sans toucher aux versions déjà prêtes : utile après avoir corrigé la cause.
create or replace function requeue_transcode_job(p_file uuid) returns boolean
  language plpgsql as $$
declare
  v_rows integer;
begin
  update transcode_jobs
     set status = 'queued', attempts = 0, locked_by = null, locked_until = null, last_error = null, finished_at = null, updated_at = now()
   where source_file_id = p_file and status in ('failed', 'done');
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end $$;

-- 7. L'état, pour la page « System » de l'admin -----------------------------------------------------------------------

create or replace function admin_transcode_status()
  returns table (
    queued bigint, running bigint, done bigint, failed bigint,
    oldest_open_at timestamptz, last_error text,
    renditions bigint, tracks_with_cdn bigint, tracks_with_audio bigint, pending_deletions bigint
  )
  language sql stable as $$
  select
    count(*) filter (where j.status = 'queued'),
    count(*) filter (where j.status = 'running'),
    count(*) filter (where j.status = 'done'),
    count(*) filter (where j.status = 'failed'),
    min(j.created_at) filter (where j.status in ('queued', 'running')),
    (select x.last_error from transcode_jobs x where x.status = 'failed' order by x.updated_at desc limit 1),
    (select count(*) from track_renditions),
    (select count(distinct track_id) from track_renditions),
    (select count(distinct track_id) from track_files where purged_at is null),
    (select count(*) from cdn_object_deletions)
  from transcode_jobs j $$;

-- Droits : ces tables et fonctions ne sont pour personne d'autre que la clé secrète (l'API et le worker). Sans
-- politique, la sécurité par ligne ferme aussi l'accès par l'interface publique de Supabase.
alter table track_renditions enable row level security;
alter table transcode_jobs enable row level security;
alter table cdn_object_deletions enable row level security;
revoke all on track_renditions, transcode_jobs, cdn_object_deletions from anon, authenticated;

revoke all on function claim_transcode_job(text, integer, integer) from public, anon, authenticated;
revoke all on function finish_transcode_job(uuid, text) from public, anon, authenticated;
revoke all on function fail_transcode_job(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function requeue_transcode_job(uuid) from public, anon, authenticated;
revoke all on function admin_transcode_status() from public, anon, authenticated;
revoke all on function track_rendition_deleted() from public, anon, authenticated;
revoke all on function track_file_enqueue_transcode() from public, anon, authenticated;
revoke all on function track_file_purged() from public, anon, authenticated;
grant execute on function claim_transcode_job(text, integer, integer) to service_role;
grant execute on function finish_transcode_job(uuid, text) to service_role;
grant execute on function fail_transcode_job(uuid, text, text, integer, integer) to service_role;
grant execute on function requeue_transcode_job(uuid) to service_role;
grant execute on function admin_transcode_status() to service_role;
