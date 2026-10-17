-- Garde-fous du bucket artist-images (photo et bannière d'artiste) : images JPEG / PNG / WebP
-- uniquement, 5 Mo au plus. Jusqu'ici le bucket acceptait n'importe quel fichier (un SVG, un
-- exécutable renommé, un fichier de plusieurs centaines de Mo).
--
-- Le Studio recadre et réduit l'image avant l'envoi (photo 1000 px, bannière 2100 px, ~300 Ko) :
-- ces limites ne sont qu'un plafond côté stockage, en plus de celles de l'API et du Studio.
-- Les fichiers déjà présents ne sont pas touchés (aucun à ce jour).
--
-- Idempotent : peut être rejoué.

update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'artist-images';
