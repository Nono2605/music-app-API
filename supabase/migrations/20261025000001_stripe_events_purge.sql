-- Fonctions de purge des événements Stripe (extrait de 20261014000003_heartbeats_key_and_retention.sql, section 3).
-- Seule cette partie est appliquée : le reste de cette migration (suppression de la colonne id des battements,
-- conservation des battements à 7 jours) reste en attente de la réponse du juriste (Q10).
-- Elle est nécessaire à la tâche planifiée « vynl-retention », qui appelle stripe_events_purge().
-- Rejouable. Prérequis : 20261013200000_billing_plans_payments.sql (table stripe_events).

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
