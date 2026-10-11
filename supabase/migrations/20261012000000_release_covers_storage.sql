-- Bucket de stockage pour les pochettes (covers) des releases : albums, EP, singles.
--
-- Public en lecture, comme artist-images : la pochette s'affiche directement dans l'app
-- d'écoute via son URL publique, stockée dans albums.cover_url. L'écriture reste
-- protégée : uniquement par URL d'upload signée, générée côté serveur (clé service_role)
-- pour une release appartenant au créateur connecté.
--
-- Garde-fous au niveau du stockage lui-même, en plus de ceux de l'API et du Studio :
-- images JPEG / PNG / WebP uniquement, 5 Mo au plus. Le Studio recadre en carré et
-- réduit l'image (1400 px, ~300 Ko) avant l'envoi : cette limite n'est qu'un plafond.
--
-- Idempotent : peut être rejoué.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'release-covers',
  'release-covers',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
