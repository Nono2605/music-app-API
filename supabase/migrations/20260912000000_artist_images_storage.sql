-- Bucket de stockage pour les avatars/bannières d'artiste. Public en
-- lecture (contrairement à track-audio) : ces images s'affichent
-- directement sur les pages artiste publiques du site listener via
-- leur URL publique stockée dans artists.avatar_url / banner_url.
-- L'upload reste protégé : toujours via Signed Upload URL générée
-- côté serveur (clé service_role), jamais en écriture libre.

insert into storage.buckets (id, name, public)
values ('artist-images', 'artist-images', true)
on conflict (id) do nothing;
