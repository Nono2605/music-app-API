-- Préférences d'écoute côté profil (paramètres, pas identité publique) :
-- contenu explicite et genres favoris, éditables depuis /account.
alter table profiles
  add column if not exists explicit_content boolean not null default true,
  add column if not exists favorite_genres text[];
