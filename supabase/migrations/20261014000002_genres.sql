-- Genre des morceaux : une liste FERMÉE (docs/SPEC_REMUNERATION.md, section 16, « Genre »).
--
-- Jusqu'ici aucun morceau n'avait de genre (seulement le genre principal déclaré par le créateur à
-- son inscription, et les genres favoris d'un auditeur, en texte libre). Sans genre sur le morceau,
-- on ne peut pas dire quels styles sont les plus écoutés. Une liste fermée évite « Hip Hop »,
-- « hip-hop », « Rap » : un code par style, un libellé affiché.
--
-- 1. genres      : la liste (code stable, libellé, ordre d'affichage, actif ou non). On désactive un genre
--                  au lieu de le supprimer : les morceaux qui l'utilisent gardent leur code.
-- 2. tracks.genre_code : le genre du morceau (vide pour les morceaux existants ; l'API l'exige à
--                  l'envoi en relecture, l'admin avertit quand il manque).
--
-- Idempotente (rejouable). Prérequis : le schéma initial (tracks). À appliquer dans le SQL Editor de
-- Supabase ; l'API continue de fonctionner avant (la liste répond « indisponible », le genre est ignoré).
-- La migration de l'admin 20261014100000_admin_genres.sql (statistiques par genre) vient APRÈS celle-ci.

create table if not exists genres (
  code        text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  label       text not null check (length(label) between 1 and 60),
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table genres enable row level security;

insert into genres (code, label, sort_order) values
  ('pop',              'Pop',                    10),
  ('rock',             'Rock',                   20),
  ('indie_alternative','Indie / Alternative',    30),
  ('hip_hop_rap',      'Hip-hop / Rap',          40),
  ('rnb_soul',         'R&B / Soul',             50),
  ('electronic',       'Electronic',             60),
  ('house_techno',     'House / Techno',         70),
  ('drum_and_bass',    'Drum & bass',            80),
  ('trance',           'Trance',                 90),
  ('ambient',          'Ambient',               100),
  ('lofi',             'Lo-fi',                 110),
  ('classical',        'Classical',             120),
  ('cinematic',        'Cinematic / Soundtrack',130),
  ('jazz',             'Jazz',                  140),
  ('blues',            'Blues',                 150),
  ('country',          'Country',               160),
  ('folk',             'Folk / Acoustic',       170),
  ('latin',            'Latin',                 180),
  ('reggae_dancehall', 'Reggae / Dancehall',    190),
  ('afrobeats',        'Afrobeats',             200),
  ('asian_pop',        'K-pop / J-pop',         210),
  ('metal',            'Metal',                 220),
  ('punk',             'Punk',                  230),
  ('funk_disco',       'Funk / Disco',          240),
  ('world',            'World',                 250),
  ('experimental',     'Experimental',          260),
  ('kids',             'Kids',                  270)
on conflict (code) do nothing;

alter table tracks add column if not exists genre_code text references genres(code);

create index if not exists idx_tracks_genre on tracks (genre_code) where genre_code is not null;

-- Demande à l'API de Supabase (PostgREST) de relire le schéma.
notify pgrst, 'reload schema';

-- =============================================================================
-- Vérification après application (à lancer à la main) :
--
--   select count(*) from genres;                      -- 27
--   select count(*) from tracks where genre_code is not null;   -- 0 au départ
-- =============================================================================
