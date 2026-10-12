-- Plafond de taille du bucket des fichiers audio (track-audio) : 200 Mo, comme l'API
-- (MAX_AUDIO_BYTES dans src/lib/audioProbe.ts). Jusqu'ici le stockage acceptait n'importe quelle
-- taille : l'artiste envoie directement au stockage avec une adresse signée, et l'API ne mesure le
-- fichier qu'APRÈS l'envoi. Avec ce plafond, un fichier trop gros est refusé dès l'envoi.
--
-- Pas de liste de types (allowed_mime_types) pour l'audio, volontairement : le type déclaré par le
-- navigateur est peu fiable (un FLAC ou un M4A arrive souvent vide ou en « text/plain »), alors
-- qu'un refus ici bloquerait des envois légitimes. L'API vérifie le format réel sur le CONTENU du
-- fichier (src/lib/audioProbe.ts) et supprime ce qui n'est pas de l'audio accepté.
--
-- Sur le plan gratuit de Supabase, la limite globale d'envoi (50 Mo par fichier) s'applique de toute
-- façon avant celle-ci : il faut le plan Pro pour des fichiers de plus de 50 Mo.
-- Les fichiers déjà présents ne sont pas touchés.
--
-- Idempotent : peut être rejoué.

update storage.buckets
set file_size_limit = 209715200 -- 200 * 1024 * 1024
where id = 'track-audio';

-- Vérification après application (à lancer à la main) :
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id;
--   -- track-audio : privé (public = false), file_size_limit = 209715200
