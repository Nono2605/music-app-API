-- Détails d'un morceau et d'une release : plusieurs genres, styles libres, artistes invités et crédits ;
-- description, label et mention de copyright d'une release.
--
-- Jusqu'ici un morceau n'avait qu'UN genre (tracks.genre_code) et rien sur les artistes qui ont travaillé
-- dessus. Le Studio demande maintenant, en créant une release, de quoi mieux présenter la musique et la
-- retrouver à la recherche.
--
--   tracks.genre_code        reste le genre PRINCIPAL (le premier choisi) : l'admin, les statistiques par genre
--                            et la règle « un genre pour soumettre » continuent de le lire tel quel.
--   tracks.extra_genre_codes les autres genres, 2 au plus (jamais celui du principal). Pas de clé étrangère
--                            sur un tableau : l'API vérifie que chaque code existe et est actif ; un genre se
--                            désactive, il ne se supprime pas, donc aucun code ne devient orphelin.
--   tracks.tags              styles libres facultatifs (« dark », « late night »…), 5 au plus, normalisés par
--                            l'API (minuscules, 2 à 24 caractères).
--   track_credits            artistes invités et autres crédits d'un morceau. `artist_id` relie à un artiste
--                            Vynl ; vide pour une personne qui n'a pas de page. `display_name` garde le nom
--                            affiché (il survit à la suppression de l'artiste lié, qui passe alors à null).
--   albums.description / label / copyright_line   facultatifs.
--
-- replace_track_credits() remplace d'un coup tous les crédits d'un morceau (supprimer puis insérer dans la
-- même transaction : jamais de morceau resté sans crédits à moitié).
--
-- Idempotente (rejouable). Prérequis : 20261014000002_genres.sql. À appliquer dans le SQL Editor de Supabase.
-- Avant elle, l'API et le Studio continuent de fonctionner : la création d'une release avec ses morceaux répond
-- « pas encore disponible », et la page d'un morceau garde son choix d'un seul genre.

alter table tracks add column if not exists extra_genre_codes text[] not null default '{}';
alter table tracks drop constraint if exists tracks_extra_genres_max;
alter table tracks add constraint tracks_extra_genres_max check (cardinality(extra_genre_codes) <= 2);

alter table tracks add column if not exists tags text[] not null default '{}';
alter table tracks drop constraint if exists tracks_tags_max;
alter table tracks add constraint tracks_tags_max check (cardinality(tags) <= 5);

create index if not exists idx_tracks_extra_genres on tracks using gin (extra_genre_codes);
create index if not exists idx_tracks_tags on tracks using gin (tags);

alter table albums add column if not exists description text;
alter table albums drop constraint if exists albums_description_length;
alter table albums add constraint albums_description_length check (description is null or char_length(description) <= 1000);

alter table albums add column if not exists label text;
alter table albums drop constraint if exists albums_label_length;
alter table albums add constraint albums_label_length check (label is null or char_length(label) <= 80);

alter table albums add column if not exists copyright_line text;
alter table albums drop constraint if exists albums_copyright_length;
alter table albums add constraint albums_copyright_length check (copyright_line is null or char_length(copyright_line) <= 120);

create table if not exists track_credits (
  id            uuid primary key default gen_random_uuid(),
  track_id      uuid not null references tracks(id) on delete cascade,
  artist_id     uuid references artists(id) on delete set null,
  display_name  text not null check (char_length(display_name) between 1 and 60),
  role          text not null default 'featured' check (role in ('featured', 'producer', 'writer')),
  position      smallint not null default 1 check (position >= 1),
  created_at    timestamptz not null default now()
);

create index if not exists idx_track_credits_track on track_credits (track_id, position);
create index if not exists idx_track_credits_artist on track_credits (artist_id) where artist_id is not null;

alter table track_credits enable row level security;

create or replace function replace_track_credits(p_track_id uuid, p_credits jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  delete from track_credits where track_id = p_track_id;

  insert into track_credits (track_id, artist_id, display_name, role, position)
  select
    p_track_id,
    nullif(c.value ->> 'artist_id', '')::uuid,
    c.value ->> 'name',
    coalesce(c.value ->> 'role', 'featured'),
    c.ordinality::smallint
  from jsonb_array_elements(coalesce(p_credits, '[]'::jsonb)) with ordinality as c(value, ordinality);
end;
$$;

revoke all on function replace_track_credits(uuid, jsonb) from public, anon, authenticated;
grant execute on function replace_track_credits(uuid, jsonb) to service_role;

-- Demande à l'API de Supabase (PostgREST) de relire le schéma.
notify pgrst, 'reload schema';

-- Vérification après application (à lancer à la main) :
--   select count(*) from track_credits;                                  -- 0 au départ
--   select count(*) from tracks where cardinality(tags) > 0;             -- 0 au départ
