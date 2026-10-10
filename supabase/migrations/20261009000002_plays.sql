-- Table des lectures (`plays`) — étape 2 de la spec (docs/SPEC_REMUNERATION.md,
-- dépôt vynl-app-v1.1.2).
--
-- Une ligne par lecture d'un morceau. C'est la matière première de tout le reste :
-- statistiques, relevés des abonnés, revenus des artistes. Une écoute non
-- enregistrée est perdue (on ne la reconstitue pas), d'où la priorité.
--
-- Étend `listening_sessions` (jamais écrite par l'API) et la renomme `plays` ;
-- remplace `listening_events` par `play_heartbeats`.
--
-- Principes :
--  * Les secondes écoutées sont calculées par le SERVEUR (validated_seconds) à
--    partir des battements de cœur du lecteur ; le client ne les déclare pas.
--  * On copie dans la lecture ce qui peut changer ensuite (artiste, album, durée
--    du morceau) : renommer ou corriger un morceau ne réécrit pas l'histoire.
--  * UN SEUL flux ouvert par compte, imposé par un index unique : même un bug de
--    l'API ne peut pas faire écouter deux morceaux « en même temps ».
--  * Une lecture n'est jamais supprimée (les clés étrangères financières sont en
--    restrict / set null depuis 20261009000000_integrity_guards.sql).
--
-- Idempotente (rejouable). Prérequis : 20261009000000 et 20261009000001
-- (colonne entitlement). À appliquer AVANT de déployer l'API qui écrit dans
-- `plays` ; l'ancienne API n'utilise pas ces tables, donc l'ordre inverse n'est
-- pas un risque pour elle.
--
-- Cette migration REFUSE de supprimer `listening_events` si elle contient des
-- lignes (rien ne l'écrit ; si elle en a, quelqu'un l'a fait à la main).

-- =============================================================================
-- 1. listening_sessions -> plays
-- =============================================================================

do $$ begin
  if to_regclass('public.listening_sessions') is not null and to_regclass('public.plays') is null then
    alter table listening_sessions rename to plays;
  end if;
end $$;

do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'plays' and column_name = 'duration_played_seconds'
  ) then
    alter table plays rename column duration_played_seconds to validated_seconds;
  end if;
end $$;

alter index if exists idx_listening_sessions_user_id rename to idx_plays_user_id;
alter index if exists idx_listening_sessions_track_id rename to idx_plays_track_id;

-- Secondes écoutées, validées par le serveur. Fractionnaires : arrondir à chaque
-- battement ferait dériver le total de plusieurs pour cent.
alter table plays add column if not exists validated_seconds numeric(10, 3);
update plays set validated_seconds = 0 where validated_seconds is null;
alter table plays
  alter column validated_seconds type numeric(10, 3) using validated_seconds::numeric(10, 3),
  alter column validated_seconds set default 0,
  alter column validated_seconds set not null;

alter table plays
  -- Copiés à la lecture (voir plus haut).
  add column if not exists artist_id uuid references artists(id) on delete restrict,
  add column if not exists album_id uuid references albums(id) on delete set null,
  add column if not exists track_duration_seconds integer,
  -- D1 : écoute qualifiée à 30 s (ou le morceau entier s'il est plus court).
  add column if not exists qualified boolean not null default false,
  add column if not exists qualified_at timestamptz,
  -- Lecture suspecte : conservée, mais exclue des calculs (jamais supprimée).
  add column if not exists counted boolean not null default true,
  add column if not exists excluded_reason text,
  -- D'où vient la lecture : source_context = album, playlist, artist, discover,
  -- search, library ; source_id = l'album / la playlist / l'artiste concerné.
  add column if not exists source_id uuid,
  add column if not exists country_code text,
  -- Identifiant choisi par le client pour UNE tentative de lecture : rejouer la
  -- même requête (réseau instable) ne crée pas de doublon.
  add column if not exists client_session_id text,
  add column if not exists app_version text,
  -- État du suivi par battements (voir src/modules/plays/heartbeat.ts).
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists last_position_seconds numeric(10, 3) not null default 0,
  add column if not exists last_state text not null default 'started',
  add column if not exists last_seq integer not null default 0;

-- Lignes qui existeraient déjà (rien ne les écrit aujourd'hui) : on les complète.
update plays p
set artist_id = t.artist_id,
    album_id = t.album_id,
    track_duration_seconds = t.duration_seconds
from tracks t
where p.track_id = t.id and p.artist_id is null;

update plays set last_heartbeat_at = coalesce(ended_at, started_at) where last_heartbeat_at is null;

alter table plays
  alter column artist_id set not null,
  alter column last_heartbeat_at set not null;

alter table plays drop constraint if exists plays_validated_seconds_check;
alter table plays add constraint plays_validated_seconds_check check (validated_seconds >= 0);

alter table plays drop constraint if exists plays_last_state_check;
alter table plays add constraint plays_last_state_check
  check (last_state in ('started', 'playing', 'paused', 'ended', 'closed'));

alter table plays drop constraint if exists plays_qualified_check;
alter table plays add constraint plays_qualified_check check (qualified = (qualified_at is not null));

-- Un seul flux ouvert (ended_at nul) par compte.
create unique index if not exists idx_plays_one_open_per_user on plays (user_id) where ended_at is null;
create unique index if not exists idx_plays_client_session
  on plays (user_id, client_session_id) where client_session_id is not null;
create index if not exists idx_plays_artist_started on plays (artist_id, started_at);
create index if not exists idx_plays_started on plays (started_at);

comment on table plays is
  'Une lecture d''un morceau. validated_seconds est calculé par le serveur ; entitlement et les copies (artiste, album, durée) sont figés à la lecture.';

-- =============================================================================
-- 2. listening_events -> play_heartbeats
-- =============================================================================

do $$ begin
  if to_regclass('public.listening_events') is not null then
    if exists (select 1 from listening_events) then
      raise exception 'listening_events is not empty: refusing to drop it. Move or delete its rows first.';
    end if;
    drop table listening_events;
  end if;
end $$;

-- Battements bruts : la preuve de la façon dont validated_seconds a été obtenu.
-- (play_id, seq) unique : un battement rejoué n'est enregistré qu'une fois.
-- À conserver peu de temps (voir la spec, Q10) : une purge reste à écrire.
create table if not exists play_heartbeats (
  id                uuid primary key default gen_random_uuid(),
  play_id           uuid not null references plays(id) on delete cascade,
  seq               integer not null,
  state             text not null check (state in ('playing', 'paused', 'ended', 'closed')),
  position_seconds  numeric(10, 3) not null,
  credited_seconds  numeric(10, 3) not null default 0,
  received_at       timestamptz not null default now(),
  unique (play_id, seq)
);
create index if not exists idx_play_heartbeats_received on play_heartbeats (received_at);
alter table play_heartbeats enable row level security;

-- =============================================================================
-- Vérification après application (à lancer à la main) :
--
--   select column_name, data_type, is_nullable from information_schema.columns
--   where table_name = 'plays' order by ordinal_position;
--
--   select to_regclass('public.plays'), to_regclass('public.play_heartbeats'),
--          to_regclass('public.listening_sessions'), to_regclass('public.listening_events');
--   -- attendu : plays, play_heartbeats, (null), (null)
-- =============================================================================
