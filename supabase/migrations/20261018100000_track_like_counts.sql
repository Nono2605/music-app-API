-- Nombre de « j'aime » par morceau (un morceau sauvegardé dans la bibliothèque d'un auditeur).
--
-- L'API affiche ce nombre à côté du cœur de chaque morceau. Elle fonctionne SANS cette migration (elle
-- compte alors les lignes une à une, ce qui devient lent quand la bibliothèque grossit) : l'appliquer
-- la rend rapide.
--
-- 1. Un index sur (item_type, item_id) : la clé unique existante commence par user_id, elle ne sert
--    pas à retrouver « qui a aimé ce morceau ».
-- 2. track_like_counts(uuid[]) : le nombre de « j'aime » de chacun des morceaux demandés, en une requête
--    (les morceaux sans « j'aime » n'ont pas de ligne : l'API les compte pour zéro).
--
-- Seul le NOMBRE sort de la base, jamais qui a aimé. Réservée à l'API (service_role), comme les autres
-- fonctions. Idempotente (rejouable). À appliquer dans le SQL Editor de Supabase.

create index if not exists idx_library_item on library (item_type, item_id);

create or replace function track_like_counts(p_track_ids uuid[])
returns table (track_id uuid, likes bigint)
language sql
stable
set search_path = public
as $$
  select item_id as track_id, count(*)::bigint as likes
  from library
  where item_type = 'track' and item_id = any(p_track_ids)
  group by item_id;
$$;

revoke all on function track_like_counts(uuid[]) from public, anon, authenticated;
grant execute on function track_like_counts(uuid[]) to service_role;
