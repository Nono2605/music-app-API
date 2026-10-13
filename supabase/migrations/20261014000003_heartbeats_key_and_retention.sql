-- Battements plus légers et conservation plus courte (docs/SPEC_REMUNERATION.md, section 14.4, S2 ;
-- section 16, tableau de conservation).
--
-- 1. CLÉ DES BATTEMENTS. `play_heartbeats` avait une clé uuid aléatoire (`id`) EN PLUS de l'unicité
--    (play_id, seq). Un uuid aléatoire gonfle l'index (les lignes s'insèrent n'importe où) et ne sert à
--    rien : un battement se désigne par son écoute et son numéro. La clé devient (play_id, seq) : un index
--    de moins, plus compact, et le même garde-fou (pas deux fois le même battement). La colonne `id` est
--    supprimée ; le code de l'API ne l'utilise pas, l'admin a été adapté AVANT cette migration.
--
-- 2. CONSERVATION. Les battements bruts ne servent qu'au contrôle et à la fraude : 7 JOURS par défaut au
--    lieu de 30 (spec 14.4, S2 ; à confirmer avec le juriste, question Q10). Les deux fonctions de purge
--    gardent leur signature, seule la valeur par défaut change. L'empreinte d'IP reste à 30 jours.
--
-- 3. ÉVÉNEMENTS STRIPE. `stripe_events` sert à ne traiter chaque événement qu'une fois ; Stripe ne rejoue
--    un événement que pendant quelques jours. On purge les événements traités ou ignorés de plus de
--    90 jours (les paiements, eux, restent : `payments`). Les échecs plus anciens sont gardés 90 jours aussi.
--
-- Rien ne s'exécute tout seul : planifier la purge est un acte volontaire (voir plus bas).
-- Idempotente (rejouable). Prérequis : 20261009000002_plays.sql, 20261013000000_privacy_consents_and_retention.sql,
-- 20261013200000_billing_plans_payments.sql.

-- =============================================================================
-- 1. Clé des battements
-- =============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'play_heartbeats' and column_name = 'id'
  ) then
    alter table public.play_heartbeats drop constraint if exists play_heartbeats_pkey;
    alter table public.play_heartbeats drop constraint if exists play_heartbeats_play_id_seq_key;
    alter table public.play_heartbeats add primary key (play_id, seq);
    alter table public.play_heartbeats drop column id;
  end if;
end
$$;

-- =============================================================================
-- 2. Conservation : 7 jours pour les battements
-- =============================================================================

create or replace function privacy_retention_preview(
  p_heartbeat_days integer default 7,
  p_ip_hash_days integer default 30
)
returns table (
  heartbeats_to_delete bigint,
  ip_hashes_to_clear bigint
)
language sql
stable
set search_path = public
as $$
  select
    (select count(*) from play_heartbeats
      where received_at < now() - make_interval(days => greatest(p_heartbeat_days, 1))),
    (select count(*) from plays
      where ip_hash is not null
        and started_at < now() - make_interval(days => greatest(p_ip_hash_days, 1)));
$$;

create or replace function privacy_retention_run(
  p_heartbeat_days integer default 7,
  p_ip_hash_days integer default 30
)
returns table (
  heartbeats_deleted bigint,
  ip_hashes_cleared bigint
)
language plpgsql
set search_path = public
as $$
declare
  v_heartbeats bigint;
  v_ip_hashes bigint;
begin
  delete from play_heartbeats
  where received_at < now() - make_interval(days => greatest(p_heartbeat_days, 1));
  get diagnostics v_heartbeats = row_count;

  update plays
  set ip_hash = null
  where ip_hash is not null
    and started_at < now() - make_interval(days => greatest(p_ip_hash_days, 1));
  get diagnostics v_ip_hashes = row_count;

  return query select v_heartbeats, v_ip_hashes;
end;
$$;

revoke all on function privacy_retention_preview(integer, integer) from public, anon, authenticated;
revoke all on function privacy_retention_run(integer, integer) from public, anon, authenticated;
grant execute on function privacy_retention_preview(integer, integer) to service_role;
grant execute on function privacy_retention_run(integer, integer) to service_role;

-- =============================================================================
-- 3. Événements Stripe déjà traités
-- =============================================================================

-- Combien seraient supprimés (sans rien modifier), puis la suppression. Minimum d'un jour.
create or replace function stripe_events_purge_preview(p_days integer default 90)
returns bigint
language sql
stable
set search_path = public
as $$
  select count(*) from stripe_events
  where received_at < now() - make_interval(days => greatest(p_days, 1));
$$;

create or replace function stripe_events_purge(p_days integer default 90)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  v_deleted bigint;
begin
  delete from stripe_events
  where received_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function stripe_events_purge_preview(integer) from public, anon, authenticated;
revoke all on function stripe_events_purge(integer) from public, anon, authenticated;
grant execute on function stripe_events_purge_preview(integer) to service_role;
grant execute on function stripe_events_purge(integer) to service_role;

-- Demande à l'API de Supabase (PostgREST) de relire le schéma.
notify pgrst, 'reload schema';

-- =============================================================================
-- Planifier la purge (OPTIONNEL, à faire à part ; c'est supprimer des données, donc un acte volontaire) :
--
--   1. Supabase > Database > Extensions : activer « pg_cron ».
--   2. Voir d'abord ce qu'elle toucherait :
--        select * from privacy_retention_preview();      -- battements > 7 j, empreintes d'IP > 30 j
--        select stripe_events_purge_preview();            -- événements Stripe > 90 j
--   3. Puis, dans le SQL Editor :
--        select cron.schedule('vynl-retention', '15 3 * * *', $$
--          select * from privacy_retention_run();
--          select stripe_events_purge();
--        $$);
--      (tous les jours à 03:15 UTC). Pour l'arrêter : select cron.unschedule('vynl-retention');
--
-- Vérification après application (à lancer à la main) :
--   select column_name from information_schema.columns where table_name = 'play_heartbeats' order by 1;
--       -- credited_seconds, play_id, position_seconds, received_at, seq, state (plus de « id »)
--   select * from privacy_retention_preview();            -- deux nombres
-- =============================================================================
