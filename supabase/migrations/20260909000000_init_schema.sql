-- BRAND — schéma initial V1
-- À exécuter dans le SQL Editor Supabase (dashboard) ou via `supabase db push`
-- une fois la CLI disponible. Idempotent (IF NOT EXISTS) pour pouvoir être
-- rejoué sans casser une exécution partielle.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Utilitaire : maintien automatique de updated_at
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------------
do $$ begin
  create type user_role as enum ('listener', 'creator', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_status as enum ('active', 'suspended', 'deleted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type content_status as enum ('draft', 'in_review', 'published', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type album_type as enum ('album', 'ep', 'single', 'compilation');
exception when duplicate_object then null; end $$;

do $$ begin
  create type library_item_type as enum ('track', 'album', 'artist', 'playlist');
exception when duplicate_object then null; end $$;

do $$ begin
  create type subscription_status as enum ('trialing', 'active', 'past_due', 'canceled', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type provenance_type as enum ('human', 'ai', 'hybrid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type declaration_status as enum ('pending_review', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type rights_holder_type as enum ('artist', 'composer', 'performer', 'label', 'publisher');
exception when duplicate_object then null; end $$;

do $$ begin
  create type rights_type as enum ('master', 'publishing', 'composition');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payout_status as enum ('pending', 'processing', 'paid', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type fraud_subject_type as enum ('user', 'track', 'session');
exception when duplicate_object then null; end $$;

-- =============================================================================
-- UTILISATEURS
-- =============================================================================

-- Compte applicatif, 1:1 avec auth.users (identité gérée par Supabase Auth)
create table if not exists users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  role          user_role not null default 'listener',
  status        user_status not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger users_set_updated_at before update on users
  for each row execute function set_updated_at();

-- Données publiques du profil, séparées du compte
create table if not exists profiles (
  user_id       uuid primary key references users(id) on delete cascade,
  username      text not null unique,
  display_name  text,
  avatar_url    text,
  bio           text,
  country       text,
  locale        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger profiles_set_updated_at before update on profiles
  for each row execute function set_updated_at();

-- =============================================================================
-- ARTISTES
-- =============================================================================

create table if not exists artists (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references users(id) on delete set null,
  name          text not null,
  slug          text not null unique,
  bio           text,
  avatar_url    text,
  banner_url    text,
  country       text,
  verified      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_artists_user_id on artists(user_id);
create trigger artists_set_updated_at before update on artists
  for each row execute function set_updated_at();

-- =============================================================================
-- MUSIQUE
-- =============================================================================

create table if not exists albums (
  id            uuid primary key default gen_random_uuid(),
  artist_id     uuid not null references artists(id) on delete cascade,
  title         text not null,
  slug          text not null unique,
  type          album_type not null default 'album',
  cover_url     text,
  release_date  date,
  status        content_status not null default 'draft',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_albums_artist_id on albums(artist_id);
create trigger albums_set_updated_at before update on albums
  for each row execute function set_updated_at();

create table if not exists tracks (
  id              uuid primary key default gen_random_uuid(),
  artist_id       uuid not null references artists(id) on delete cascade,
  album_id        uuid references albums(id) on delete set null,
  title           text not null,
  slug            text not null unique,
  track_number    integer,
  duration_seconds integer,
  isrc            text,
  explicit        boolean not null default false,
  status          content_status not null default 'draft',
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_tracks_artist_id on tracks(artist_id);
create index if not exists idx_tracks_album_id on tracks(album_id);
create trigger tracks_set_updated_at before update on tracks
  for each row execute function set_updated_at();

-- Fichiers physiques d'un morceau (plusieurs qualités/formats possibles).
-- storage_provider + storage_key : jamais d'URL absolue en dur, pour permettre
-- de changer de storage/CDN sans réécrire l'application (voir ARCHITECTURE.md).
create table if not exists track_files (
  id                uuid primary key default gen_random_uuid(),
  track_id          uuid not null references tracks(id) on delete cascade,
  storage_provider  text not null default 'supabase',
  storage_key       text not null,
  format            text not null,
  quality_label     text not null default 'standard',
  bitrate_kbps      integer,
  file_size_bytes   bigint,
  checksum          text,
  created_at        timestamptz not null default now()
);
create index if not exists idx_track_files_track_id on track_files(track_id);

-- =============================================================================
-- PLAYLISTS
-- =============================================================================

create table if not exists playlists (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references users(id) on delete cascade,
  title         text not null,
  description   text,
  cover_url     text,
  is_public     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_playlists_owner_id on playlists(owner_id);
create trigger playlists_set_updated_at before update on playlists
  for each row execute function set_updated_at();

create table if not exists playlist_tracks (
  id            uuid primary key default gen_random_uuid(),
  playlist_id   uuid not null references playlists(id) on delete cascade,
  track_id      uuid not null references tracks(id) on delete cascade,
  position      integer not null,
  added_by      uuid references users(id) on delete set null,
  added_at      timestamptz not null default now(),
  unique (playlist_id, track_id)
);
create index if not exists idx_playlist_tracks_playlist_id on playlist_tracks(playlist_id);

-- =============================================================================
-- RELATIONS
-- =============================================================================

-- Follow polymorphe restreint : soit un artiste, soit un utilisateur, jamais les deux.
create table if not exists follows (
  id                  uuid primary key default gen_random_uuid(),
  follower_id         uuid not null references users(id) on delete cascade,
  artist_id           uuid references artists(id) on delete cascade,
  followed_user_id    uuid references users(id) on delete cascade,
  created_at          timestamptz not null default now(),
  constraint follows_target_check check (
    (artist_id is not null and followed_user_id is null) or
    (artist_id is null and followed_user_id is not null)
  ),
  unique (follower_id, artist_id),
  unique (follower_id, followed_user_id)
);
create index if not exists idx_follows_follower_id on follows(follower_id);

-- Bibliothèque personnelle (morceaux/albums/artistes/playlists sauvegardés).
create table if not exists library (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  item_type   library_item_type not null,
  item_id     uuid not null,
  added_at    timestamptz not null default now(),
  unique (user_id, item_type, item_id)
);
create index if not exists idx_library_user_id on library(user_id);

-- =============================================================================
-- ÉCOUTE
-- =============================================================================

create table if not exists listening_sessions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(id) on delete cascade,
  track_id                uuid not null references tracks(id) on delete cascade,
  source_context          text,
  started_at              timestamptz not null default now(),
  ended_at                timestamptz,
  duration_played_seconds integer,
  completed               boolean not null default false,
  device_type             text,
  ip_hash                 text,
  created_at              timestamptz not null default now()
);
create index if not exists idx_listening_sessions_user_id on listening_sessions(user_id);
create index if not exists idx_listening_sessions_track_id on listening_sessions(track_id);

-- Évènements fins (play/pause/seek/skip) au sein d'une session — alimente
-- l'anti-fraude et l'analytics détaillée. Optionnel selon le besoin réel.
create table if not exists listening_events (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references listening_sessions(id) on delete cascade,
  event_type    text not null,
  position_seconds integer,
  created_at    timestamptz not null default now()
);
create index if not exists idx_listening_events_session_id on listening_events(session_id);

-- =============================================================================
-- ABONNEMENTS
-- =============================================================================

create table if not exists subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references users(id) on delete cascade,
  plan                      text not null,
  status                    subscription_status not null default 'trialing',
  provider                  text,
  provider_subscription_id  text,
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  cancel_at_period_end      boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index if not exists idx_subscriptions_user_id on subscriptions(user_id);
create trigger subscriptions_set_updated_at before update on subscriptions
  for each row execute function set_updated_at();

-- =============================================================================
-- ROYALTIES
-- =============================================================================

create table if not exists royalty_periods (
  id                uuid primary key default gen_random_uuid(),
  period_start      date not null,
  period_end        date not null,
  status            text not null default 'open',
  total_revenue_cents bigint not null default 0,
  currency          text not null default 'USD',
  created_at        timestamptz not null default now(),
  closed_at         timestamptz,
  unique (period_start, period_end)
);

create table if not exists royalty_allocations (
  id                    uuid primary key default gen_random_uuid(),
  royalty_period_id     uuid not null references royalty_periods(id) on delete cascade,
  track_id              uuid not null references tracks(id) on delete cascade,
  artist_id             uuid not null references artists(id) on delete cascade,
  listens_count         bigint not null default 0,
  allocated_amount_cents bigint not null default 0,
  currency              text not null default 'USD',
  created_at            timestamptz not null default now(),
  unique (royalty_period_id, track_id, artist_id)
);
create index if not exists idx_royalty_allocations_period on royalty_allocations(royalty_period_id);
create index if not exists idx_royalty_allocations_artist on royalty_allocations(artist_id);

create table if not exists creator_wallets (
  id            uuid primary key default gen_random_uuid(),
  artist_id     uuid not null unique references artists(id) on delete cascade,
  balance_cents bigint not null default 0,
  currency      text not null default 'USD',
  updated_at    timestamptz not null default now()
);
create trigger creator_wallets_set_updated_at before update on creator_wallets
  for each row execute function set_updated_at();

create table if not exists payouts (
  id                  uuid primary key default gen_random_uuid(),
  creator_wallet_id   uuid not null references creator_wallets(id) on delete cascade,
  amount_cents        bigint not null,
  currency            text not null default 'USD',
  status              payout_status not null default 'pending',
  provider            text,
  provider_payout_id  text,
  requested_at        timestamptz not null default now(),
  paid_at             timestamptz
);
create index if not exists idx_payouts_wallet_id on payouts(creator_wallet_id);

-- =============================================================================
-- IA
-- =============================================================================

-- Historique des déclarations de provenance par morceau (traçabilité/conformité).
-- La plus récente (declared_at desc) fait foi côté application.
create table if not exists ai_declarations (
  id            uuid primary key default gen_random_uuid(),
  track_id      uuid not null references tracks(id) on delete cascade,
  provenance    provenance_type not null,
  ai_tool_names text[],
  description   text,
  status        declaration_status not null default 'pending_review',
  declared_by   uuid references users(id) on delete set null,
  declared_at   timestamptz not null default now(),
  reviewed_by   uuid references users(id) on delete set null,
  reviewed_at   timestamptz
);
create index if not exists idx_ai_declarations_track_id on ai_declarations(track_id);

-- =============================================================================
-- DROITS
-- =============================================================================

create table if not exists rights (
  id                  uuid primary key default gen_random_uuid(),
  track_id            uuid not null references tracks(id) on delete cascade,
  rights_holder_name  text not null,
  rights_holder_type  rights_holder_type not null,
  rights_type         rights_type not null,
  territory           text not null default 'worldwide',
  created_at          timestamptz not null default now()
);
create index if not exists idx_rights_track_id on rights(track_id);

-- Répartition des royalties par ayant droit. La somme des percentage pour un
-- même track_id doit valoir 100 — invariant applicatif, non enforced en SQL.
create table if not exists splits (
  id            uuid primary key default gen_random_uuid(),
  track_id      uuid not null references tracks(id) on delete cascade,
  rights_id     uuid references rights(id) on delete cascade,
  artist_id     uuid references artists(id) on delete cascade,
  percentage    numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  created_at    timestamptz not null default now(),
  constraint splits_target_check check (
    (artist_id is not null and rights_id is null) or
    (artist_id is null and rights_id is not null)
  )
);
create index if not exists idx_splits_track_id on splits(track_id);

-- =============================================================================
-- FRAUDE
-- =============================================================================

create table if not exists fraud_events (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references users(id) on delete set null,
  track_id              uuid references tracks(id) on delete set null,
  listening_session_id  uuid references listening_sessions(id) on delete set null,
  event_type            text not null,
  severity              text not null default 'low',
  details               jsonb,
  detected_at           timestamptz not null default now(),
  resolved              boolean not null default false,
  resolved_at           timestamptz
);
create index if not exists idx_fraud_events_user_id on fraud_events(user_id);
create index if not exists idx_fraud_events_track_id on fraud_events(track_id);

create table if not exists fraud_scores (
  id            uuid primary key default gen_random_uuid(),
  subject_type  fraud_subject_type not null,
  subject_id    uuid not null,
  score         numeric(5,2) not null,
  factors       jsonb,
  computed_at   timestamptz not null default now()
);
create index if not exists idx_fraud_scores_subject on fraud_scores(subject_type, subject_id);

-- =============================================================================
-- RLS — activée sur toutes les tables, aucune policy définie.
-- Seule l'API (clé service_role, qui bypass RLS) écrit/lit ces données ;
-- les rôles anon/authenticated n'ont donc accès à rien par défaut.
-- =============================================================================

do $$
declare
  t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public'
    and tablename in (
      'users','profiles','artists','albums','tracks','track_files',
      'playlists','playlist_tracks','follows','library',
      'listening_sessions','listening_events','subscriptions',
      'royalty_periods','royalty_allocations','creator_wallets','payouts',
      'ai_declarations','rights','splits','fraud_events','fraud_scores'
    )
  loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;
