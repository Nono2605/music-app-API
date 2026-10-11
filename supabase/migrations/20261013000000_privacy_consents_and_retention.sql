-- Vie privée : consentements (historique inaltérable) et conservation limitée des
-- données d'écoute les plus fines (docs/SPEC_REMUNERATION.md, Q10 et Q14).
--
-- 1. CONSENTEMENTS. Une ligne par décision d'un compte sur une finalité : « j'accepte les
--    conditions et la politique de confidentialité (version X) », « j'ai l'âge minimum »,
--    « j'accepte / je refuse la publicité personnalisée ». On AJOUTE une ligne à chaque
--    décision, on ne modifie jamais : l'état actuel est la ligne la plus récente de chaque
--    finalité, et l'historique prouve ce qui a été accepté, quand et pour quelle version du
--    texte (spec : « l'historique est conservé »). Un trigger refuse toute modification, et
--    toute suppression directe ; seule la suppression en cascade d'un compte les efface.
--
-- 2. CONSERVATION. `play_heartbeats` (battements bruts) ne sert qu'au contrôle et à la
--    fraude : purge au-delà de 30 jours par défaut. `plays.ip_hash` (empreinte d'IP salée,
--    changeante chaque jour) n'a plus d'intérêt une fois la fenêtre d'analyse passée : mise à
--    null au-delà de 30 jours. Les écoutes elles-mêmes (preuve de ce qui est dû aux artistes)
--    ne sont PAS supprimées. Les durées sont des paramètres (Q10 : à confirmer par un
--    juriste) ; rien ne s'exécute tout seul tant qu'on ne planifie pas la purge (voir plus bas).
--
-- Idempotente (rejouable). Prérequis : 20261009000002_plays.sql.
-- À appliquer dans le SQL Editor de Supabase AVANT de déployer l'API qui lit `consents`
-- (sans elle, les routes de vie privée répondent 503 `privacy_unavailable`).

-- =============================================================================
-- 1. Consentements
-- =============================================================================

create table if not exists consents (
  id             uuid primary key default gen_random_uuid(),
  -- Supprimés avec le compte (cascade) : on ne garde pas de preuve de consentement d'un
  -- compte qui n'existe plus. Un compte « supprimé » est de toute façon anonymisé, pas effacé.
  user_id        uuid not null references users(id) on delete cascade,
  -- Finalité : terms, age_16, ads_personalization, analytics… Texte (pas un type énuméré) :
  -- ajouter une finalité ne demande pas de migration ; l'API valide la liste.
  purpose        text not null check (purpose ~ '^[a-z][a-z0-9_]{1,40}$'),
  granted        boolean not null,
  -- Version du texte (politique, conditions) affichée au moment de la décision.
  policy_version text not null check (length(policy_version) between 1 and 40),
  -- D'où vient la décision : écran d'accueil, réglages, autre.
  source         text not null default 'settings' check (source in ('welcome', 'settings', 'signup', 'banner', 'api')),
  created_at     timestamptz not null default now()
);

-- « Dernière décision de ce compte sur cette finalité » : l'accès le plus fréquent.
create index if not exists idx_consents_user_purpose on consents (user_id, purpose, created_at desc);

-- Comme les autres tables : RLS activée sans policy, seule la clé secret y accède.
alter table consents enable row level security;

-- Inaltérable : aucune modification ; une suppression n'est permise que lorsqu'elle vient
-- de la cascade d'un compte supprimé (le trigger de clé étrangère s'exécute un niveau plus
-- haut que la requête de l'utilisateur).
create or replace function consents_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'consents rows cannot be modified: record a new decision instead'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' and pg_trigger_depth() < 2 then
    raise exception 'consents rows cannot be deleted directly'
      using errcode = '23514';
  end if;

  return old;
end;
$$;

drop trigger if exists consents_guard on consents;
create trigger consents_guard
  before update or delete on consents
  for each row execute function consents_guard();

-- État actuel : la décision la plus récente de chaque compte pour chaque finalité.
create or replace view consents_current as
  select distinct on (user_id, purpose)
    user_id, purpose, granted, policy_version, source, created_at
  from consents
  order by user_id, purpose, created_at desc, id desc;

-- La vue s'exécute avec les droits de CELUI QUI L'INTERROGE (donc soumise à la RLS de
-- `consents`), et on retire tout accès à anon / authenticated : sans cela PostgREST
-- l'exposerait à tout porteur de la clé publique.
alter view consents_current set (security_invoker = true);
revoke all on consents_current from public, anon, authenticated;
grant select on consents_current to service_role;

-- =============================================================================
-- 2. Conservation limitée
-- =============================================================================

-- Aperçu : combien de lignes seraient touchées, SANS rien modifier. Sert de contrôle avant
-- de planifier la purge, et à l'admin pour vérifier qu'elle tourne.
create or replace function privacy_retention_preview(
  p_heartbeat_days integer default 30,
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

-- Purge : supprime les battements bruts anciens et efface les empreintes d'IP anciennes.
-- Les écoutes (`plays`) restent : ce sont les pièces qui justifient ce qui est dû aux
-- artistes. Un minimum d'un jour évite qu'un paramètre à 0 ne vide tout.
create or replace function privacy_retention_run(
  p_heartbeat_days integer default 30,
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

-- Demande à l'API de Supabase (PostgREST) de relire le schéma.
notify pgrst, 'reload schema';

-- =============================================================================
-- Planifier la purge (OPTIONNEL, à faire à part, une fois les durées confirmées) :
--
--   1. Supabase > Database > Extensions : activer « pg_cron ».
--   2. Puis, dans le SQL Editor :
--        select cron.schedule(
--          'vynl-privacy-retention', '15 3 * * *',
--          $$ select * from privacy_retention_run(30, 30) $$
--        );
--      (tous les jours à 03:15 UTC). Pour l'arrêter : select cron.unschedule('vynl-privacy-retention');
--
-- Avant, voir ce qu'elle toucherait :
--      select * from privacy_retention_preview(30, 30);
--
-- Vérification après application (à lancer à la main) :
--      select count(*) from consents;                       -- 0 au départ
--      select * from privacy_retention_preview();           -- deux nombres
-- =============================================================================
