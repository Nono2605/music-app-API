-- Bucket de stockage pour les fichiers audio uploadés par les créateurs.
-- Privé : la lecture se fait via URL signée, jamais via une URL publique.
-- Aucune policy storage.objects nécessaire — les uploads passent par une
-- Signed Upload URL générée côté serveur (clé service_role), déjà
-- pré-autorisée pour son chemin sans dépendre de RLS.

insert into storage.buckets (id, name, public)
values ('track-audio', 'track-audio', false)
on conflict (id) do nothing;
