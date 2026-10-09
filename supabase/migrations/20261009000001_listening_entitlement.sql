-- À quel titre une écoute a lieu (spec : docs/SPEC_REMUNERATION.md, décision D12,
-- dépôt vynl-app-v1.1.2).
--
-- Le revenu de chaque écoute dépend de ce qui l'autorise : un abonnement payant,
-- la publicité d'un compte gratuit, un essai, ou la bêta (aucun revenu). Cette
-- information doit être figée DANS l'écoute au moment où elle a lieu : on ne
-- peut pas la reconstituer plus tard (un utilisateur change de formule, la
-- bêta se termine).
--
-- La table s'appelle encore listening_sessions ; elle deviendra `plays` à
-- l'étape 2 de la spec. Rien ne l'écrit pour l'instant.
--
-- Pas de valeur par défaut, volontairement : l'API devra toujours dire à quel
-- titre l'écoute a lieu. Un défaut `beta` classerait en silence, comme non
-- rémunérées, des écoutes d'abonnés dont on aurait oublié de préciser le droit.
-- Les lignes qui existent déjà (s'il y en a) datent de la bêta : elles prennent
-- `beta`, le temps de l'ajout, puis le défaut est retiré.
--
-- Idempotente (rejouable). Indépendante de 20261009000000_integrity_guards.sql
-- (ordre d'application indifférent).

do $$ begin
  create type entitlement_type as enum ('beta', 'subscriber', 'free_ad_supported', 'trial');
exception when duplicate_object then null; end $$;

alter table listening_sessions
  add column if not exists entitlement entitlement_type not null default 'beta';

alter table listening_sessions
  alter column entitlement drop default;

comment on column listening_sessions.entitlement is
  'Droit d''écoute au moment de la lecture : beta (aucun revenu), subscriber (abonnement payant actif), free_ad_supported (gratuit avec publicité), trial (essai). Figé, jamais recalculé.';

-- =============================================================================
-- Vérification après application (à lancer à la main) :
--
--   select column_name, data_type, udt_name, is_nullable, column_default
--   from information_schema.columns
--   where table_name = 'listening_sessions' and column_name = 'entitlement';
--   -- attendu : USER-DEFINED / entitlement_type / NO / (pas de défaut)
-- =============================================================================
