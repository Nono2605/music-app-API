-- File des contrôles automatiques d'un morceau envoyé en relecture (docs/SPEC_REMUNERATION.md, section 15.5 : C3).
--
-- Quand un artiste envoie un morceau (ou une release) en relecture, l'API met le morceau dans cette file ; un exécuteur
-- intégré à l'API (src/lib/scanRunner.ts) prend les tâches une à une, lance les contrôles et écrit leurs résultats dans le
-- journal track_scans. L'administrateur voit ces résultats avant de décider.
--
-- Même modèle que la file de transcodage (migration 20261025000000) : une tâche est PRISE pour une durée (un « bail »).
-- Si l'API s'endort ou plante en cours de route, le bail s'achève et la tâche est reprise ; trois essais, avec une attente
-- entre deux, puis la tâche passe en « failed » (l'admin le voit : « scan unavailable »).
--
--   scan_jobs           une tâche par morceau à contrôler. UNE SEULE tâche ouverte (queued / running) par morceau :
--                       envoyer deux fois de suite le même morceau en relecture ne double pas le travail.
--   enqueue_track_scans() met un morceau en file (sans doublon) ; rend l'identifiant de la tâche, ou null s'il y en a
--                       déjà une d'ouverte.
--   claim_scan_job() / finish_scan_job() / fail_scan_job()   les trois temps d'une tâche.
--
-- Rien ici ne bloque un artiste : c'est l'API qui décide de mettre en file « au mieux », et l'admin de tenir compte des
-- résultats. Aucune de ces tables n'est lisible par les comptes de l'application (sécurité par ligne sans politique) :
-- seule la clé secrète y accède (l'API et l'admin).
--
-- Prérequis : la table tracks. Idempotente. À appliquer dans le SQL Editor de Supabase. Sans elle, l'API continue de
-- fonctionner : aucun contrôle n'est lancé, et l'admin le dit.

create table if not exists scan_jobs (
  id           uuid primary key default gen_random_uuid(),
  track_id     uuid not null references tracks(id) on delete cascade,
  -- Pourquoi : envoyé en relecture, relancé à la main par l'admin, ou relance périodique du catalogue.
  reason       text not null default 'submit' check (reason in ('submit', 'manual', 'periodic')),
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts     integer not null default 0,
  locked_by    text,
  -- « queued » : pas avant cette date (attente entre deux essais). « running » : fin du bail.
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists idx_scan_jobs_open on scan_jobs(created_at) where status in ('queued', 'running');
create index if not exists idx_scan_jobs_track on scan_jobs(track_id, created_at desc);
-- Une seule tâche ouverte par morceau.
create unique index if not exists uq_scan_jobs_open_track on scan_jobs(track_id) where status in ('queued', 'running');

-- Met un morceau en file. Rend l'identifiant de la tâche créée, ou null si une tâche est déjà ouverte pour lui (ou si le
-- morceau n'existe pas).
create or replace function enqueue_track_scans(p_track uuid, p_reason text default 'submit') returns uuid
  language plpgsql as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from tracks where id = p_track) then return null; end if;
  insert into scan_jobs (track_id, reason) values (p_track, p_reason)
  on conflict (track_id) where status in ('queued', 'running') do nothing
  returning id into v_id;
  return v_id;
end $$;

-- Prend la plus ancienne tâche disponible : en attente (et dont l'attente est finie) ou « running » dont le bail est échu
-- (exécuteur disparu). `for update skip locked` : deux exécuteurs ne prennent jamais la même. Une tâche qui a épuisé ses
-- essais passe en « failed » au lieu d'être reprise sans fin.
create or replace function claim_scan_job(p_worker text, p_lease_seconds integer default 300, p_max_attempts integer default 3)
  returns table (job_id uuid, track_id uuid, reason text, attempts integer)
  language plpgsql as $$
declare
  v_id uuid;
begin
  update scan_jobs
     set status = 'failed', locked_by = null, locked_until = null, finished_at = now(), updated_at = now(),
         last_error = coalesce(last_error, 'bail échu après le dernier essai')
   where status = 'running' and locked_until < now() and scan_jobs.attempts >= p_max_attempts;

  select j.id into v_id
    from scan_jobs j
   where j.status in ('queued', 'running')
     and coalesce(j.locked_until, '-infinity'::timestamptz) < now()
     and j.attempts < p_max_attempts
   order by j.created_at
   for update skip locked
   limit 1;
  if v_id is null then return; end if;

  update scan_jobs j
     set status = 'running', attempts = j.attempts + 1, locked_by = p_worker, updated_at = now(),
         locked_until = now() + make_interval(secs => p_lease_seconds)
   where j.id = v_id;

  return query
    select j.id, j.track_id, j.reason, j.attempts from scan_jobs j where j.id = v_id;
end $$;

-- Marque la tâche terminée, seulement par l'exécuteur qui la détient (un bail repris par un autre ne se termine pas).
create or replace function finish_scan_job(p_job uuid, p_worker text) returns boolean
  language plpgsql as $$
declare
  v_rows integer;
begin
  update scan_jobs
     set status = 'done', locked_by = null, locked_until = null, last_error = null, finished_at = now(), updated_at = now()
   where id = p_job and status = 'running' and locked_by = p_worker;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end $$;

-- Un essai a échoué : on rend la tâche après une attente, ou on l'abandonne (« failed ») quand les essais sont épuisés.
create or replace function fail_scan_job(p_job uuid, p_worker text, p_error text, p_retry_after_seconds integer default 120, p_max_attempts integer default 3)
  returns text
  language plpgsql as $$
declare
  v_attempts integer;
  v_status text;
begin
  select attempts into v_attempts from scan_jobs where id = p_job and status = 'running' and locked_by = p_worker for update;
  if not found then return 'ignored'; end if;

  v_status := case when v_attempts >= p_max_attempts then 'failed' else 'queued' end;
  update scan_jobs
     set status = v_status, locked_by = null, updated_at = now(), last_error = left(coalesce(p_error, 'erreur inconnue'), 1000),
         locked_until = case when v_status = 'queued' then now() + make_interval(secs => p_retry_after_seconds) else null end,
         finished_at = case when v_status = 'failed' then now() else null end
   where id = p_job;
  return v_status;
end $$;

-- Droits : réservés à la clé secrète (l'API et l'admin). Sans politique, la sécurité par ligne ferme aussi l'accès par
-- l'interface publique de Supabase.
alter table scan_jobs enable row level security;
revoke all on scan_jobs from anon, authenticated;

revoke all on function enqueue_track_scans(uuid, text) from public, anon, authenticated;
revoke all on function claim_scan_job(text, integer, integer) from public, anon, authenticated;
revoke all on function finish_scan_job(uuid, text) from public, anon, authenticated;
revoke all on function fail_scan_job(uuid, text, text, integer, integer) from public, anon, authenticated;
