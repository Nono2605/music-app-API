-- Relecture du nom d'artiste : un nom proche d'un nom existant doit être validé par l'administration
-- avant que la page de l'artiste soit publique et que sa musique puisse partir en relecture.
--
-- Jusqu'ici tout nom qui passait les contrôles automatiques (format, mots réservés, unicité) était
-- accepté tout de suite ; les noms qui RESSEMBLENT à un autre étaient seulement signalés dans le journal
-- des contrôles (track_scans), sans rien bloquer, et personne ne pouvait refuser un nom.
--
--   name_status       'approved' : le nom est accepté (état de tous les artistes existants, et de tout
--                                  nouveau nom sans ressemblance) ;
--                     'pending'  : un nom proche d'un autre existe, l'administration doit trancher. La page
--                                  n'est pas publique et aucune release ne peut être soumise ;
--                     'rejected' : l'administration a refusé le nom (motif dans name_review_note, lisible par
--                                  l'artiste), qui en choisit un autre.
--   name_review_note  le motif d'un refus ; jamais de donnée personnelle.
--   name_reviewed_at  quand l'administration a tranché.
--
-- Qui a tranché, et quand, est dans admin_audit_log (écrit avant chaque action de l'admin).
-- Idempotente (rejouable). Prérequis : 20261011000000_catalog_numbers_and_artist_names.sql.
-- À appliquer dans le SQL Editor de Supabase. Avant elle, l'API et le Studio continuent de fonctionner :
-- tous les noms sont alors considérés comme acceptés.

alter table artists add column if not exists name_status text not null default 'approved';

alter table artists drop constraint if exists artists_name_status_check;
alter table artists add constraint artists_name_status_check
  check (name_status in ('approved', 'pending', 'rejected'));

alter table artists add column if not exists name_review_note text;

alter table artists drop constraint if exists artists_name_review_note_length;
alter table artists add constraint artists_name_review_note_length
  check (name_review_note is null or length(name_review_note) <= 500);

alter table artists add column if not exists name_reviewed_at timestamptz;

-- Les noms à relire (une petite minorité) se retrouvent vite.
create index if not exists idx_artists_name_to_review on artists (created_at) where name_status <> 'approved';

-- Demande à l'API de Supabase (PostgREST) de relire le schéma.
notify pgrst, 'reload schema';

-- Vérification après application (à lancer à la main) :
--   select name_status, count(*) from artists group by 1;      -- « approved » pour tous au départ
