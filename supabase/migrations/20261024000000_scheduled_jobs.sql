-- Tâches planifiées (pg_cron) : détection de fraude chaque jour, purges de conservation, ménage du journal de pg_cron.
--
-- Pourquoi maintenant : le règlement d'un abonnement (spec, section 9) suppose que la détection de fraude a tourné sur
-- chaque jour écoulé ; et les durées de conservation (battements 7 jours, empreintes d'IP 30 jours, événements Stripe
-- 90 jours) ne sont tenues que si la purge tourne vraiment.
--
-- Ce que fait cette migration :
--   1. active pg_cron si le SQL le permet ; sinon elle le dit (Supabase > Database > Extensions > pg_cron, puis la
--      rejouer : elle est rejouable sans danger) ;
--   2. planifie trois tâches, chacune PAR SON NOM (une tâche déjà là est mise à jour, jamais dupliquée) :
--        vynl-retention    tous les jours à 03:15 UTC       privacy_retention_run() puis stripe_events_purge()
--        vynl-fraud-detect tous les jours à 03:30 UTC       fraud_detect() : les trois derniers jours complets
--        vynl-cron-log     le dimanche à 04:00 UTC          supprime le journal de pg_cron de plus de 14 jours
--   3. crée admin_scheduled_jobs() : la liste de ces tâches et leur dernière exécution, pour la page « System » de
--      l'admin (lecture seule, réservée à la clé secrète).
--
-- ATTENTION : la tâche vynl-retention SUPPRIME des données (battements de plus de 7 jours, empreintes d'IP de plus de
-- 30 jours, événements Stripe de plus de 90 jours : les durées de la spécification, section 16). Voir d'abord :
--      select * from privacy_retention_preview();      -- deux nombres
--      select stripe_events_purge_preview();           -- un nombre
-- Pour l'arrêter : select cron.unschedule('vynl-retention');
--
-- Prérequis : 20261014000003 (purges) et 20261014000005 (détection de fraude). Idempotente.

do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron n''a pas pu être activé par SQL (%). Activez-le dans Supabase > Database > Extensions, puis rejouez cette migration.', sqlerrm;
  end;

  if to_regnamespace('cron') is null then
    raise notice 'pg_cron est absent : aucune tâche n''a été planifiée.';
    return;
  end if;

  perform cron.schedule(
    'vynl-retention', '15 3 * * *',
    $job$
      select * from privacy_retention_run();
      select stripe_events_purge();
    $job$
  );
  perform cron.schedule('vynl-fraud-detect', '30 3 * * *', $job$ select * from fraud_detect() $job$);
  perform cron.schedule(
    'vynl-cron-log', '0 4 * * 0',
    $job$ delete from cron.job_run_details where end_time < now() - interval '14 days' $job$
  );
end
$$;

-- Les tâches Vynl et leur dernière exécution. Vide si pg_cron n'est pas activé (jamais une erreur).
create or replace function admin_scheduled_jobs()
returns table (
  job_name         text,
  schedule         text,
  active           boolean,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_status      text,
  last_message     text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if to_regclass('cron.job') is null then
    return;
  end if;

  return query execute $q$
    select j.jobname::text, j.schedule::text, j.active,
           r.start_time, r.end_time, r.status::text, left(r.return_message, 300)
    from cron.job j
    left join lateral (
      select d.start_time, d.end_time, d.status, d.return_message
      from cron.job_run_details d
      where d.jobid = j.jobid
      order by d.start_time desc
      limit 1
    ) r on true
    where j.jobname like 'vynl-%'
    order by j.jobname
  $q$;
end
$$;

revoke all on function admin_scheduled_jobs() from public, anon, authenticated;
grant execute on function admin_scheduled_jobs() to service_role;

-- Demande à l'API de Supabase (PostgREST) de relire le schéma.
notify pgrst, 'reload schema';

-- Vérification après application (à lancer à la main) :
--   select * from admin_scheduled_jobs();     -- trois lignes ; la dernière exécution est vide jusqu'à la première nuit
--   select jobname, schedule, active from cron.job where jobname like 'vynl-%' order by jobname;
--   -- le lendemain : select * from admin_scheduled_jobs();   -- last_status = 'succeeded'
