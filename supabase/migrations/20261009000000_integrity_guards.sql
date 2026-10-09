-- Garde-fous d'intégrité — migration corrective (spec : docs/SPEC_REMUNERATION.md,
-- section 11, dépôt vynl-app-v1.1.2).
--
-- Problème : tout le schéma financier reposait sur `on delete cascade`. Vérifié
-- sur une base de test avant cette migration :
--   * publier -> repasser en brouillon -> supprimer un morceau efface ses écoutes
--     et ses allocations de royalties (chemin ouvert aux créateurs par l'API) ;
--   * supprimer une fiche artiste efface aussi ses morceaux, son portefeuille et
--     ses paiements ;
--   * supprimer un compte efface son historique d'écoute et son abonnement.
-- Or ces données sont la preuve de ce qui est dû aux artistes et de où va
-- l'argent des abonnés : elles ne doivent ni disparaître ni se modifier.
--
-- Principe : on retire ou on archive, on ne supprime pas. Un compte supprimé
-- est anonymisé (user_id -> null), son historique reste.
--
-- Idempotente : peut être rejouée sans casser une exécution partielle (les
-- clés étrangères sont retrouvées par colonne, pas par nom, donc même si la base
-- réelle a des noms de contraintes différents de ceux du schéma initial).
--
-- À SAVOIR avant de l'appliquer :
--   * Publier à la main exige désormais une durée (> 0) et au moins un fichier
--     audio. Exemple :
--       update tracks set duration_seconds = 215, status = 'published',
--              published_by = '<uuid admin>' where id = '<uuid morceau>';
--     (published_at est posé automatiquement s'il est vide.)
--   * Un morceau publié ne peut plus repasser en brouillon / en relecture : on
--     l'archive (status = 'archived').
--   * Retour arrière : recréer les clés étrangères avec `on delete cascade` et
--     supprimer les deux triggers (tracks_lifecycle, tracks_no_delete_published).

-- =============================================================================
-- 1. Clés étrangères : plus de cascade vers l'historique financier
-- =============================================================================

-- Retrouve la clé étrangère (une seule colonne) de p_table.p_column vers p_ref,
-- quel que soit son nom, la supprime et la recrée avec la règle voulue.
create or replace function pg_temp.replace_fk(
  p_table regclass,
  p_column text,
  p_ref regclass,
  p_on_delete text
) returns void
language plpgsql
as $$
declare
  existing record;
  new_name text := format('%s_%s_fkey', (select relname from pg_class where oid = p_table), p_column);
begin
  for existing in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.contype = 'f'
      and con.conrelid = p_table
      and con.confrelid = p_ref
      and att.attname = p_column
      and array_length(con.conkey, 1) = 1
  loop
    execute format('alter table %s drop constraint %I', p_table, existing.conname);
  end loop;

  execute format(
    'alter table %s add constraint %I foreign key (%I) references %s (id) on delete %s',
    p_table, new_name, p_column, p_ref, p_on_delete
  );
end;
$$;

-- Écoutes : on garde l'historique d'un compte supprimé (anonymisé) ; un morceau
-- écouté ne peut pas être supprimé.
alter table listening_sessions alter column user_id drop not null;
select pg_temp.replace_fk('listening_sessions', 'user_id', 'users', 'set null');
select pg_temp.replace_fk('listening_sessions', 'track_id', 'tracks', 'restrict');

-- Abonnement : l'historique de facturation survit à la suppression du compte.
alter table subscriptions alter column user_id drop not null;
select pg_temp.replace_fk('subscriptions', 'user_id', 'users', 'set null');

-- Royalties, portefeuilles, paiements : jamais supprimés en cascade.
select pg_temp.replace_fk('royalty_allocations', 'royalty_period_id', 'royalty_periods', 'restrict');
select pg_temp.replace_fk('royalty_allocations', 'track_id', 'tracks', 'restrict');
select pg_temp.replace_fk('royalty_allocations', 'artist_id', 'artists', 'restrict');
select pg_temp.replace_fk('creator_wallets', 'artist_id', 'artists', 'restrict');
select pg_temp.replace_fk('payouts', 'creator_wallet_id', 'creator_wallets', 'restrict');

-- Un artiste qui a du catalogue ne se supprime pas : on archive.
select pg_temp.replace_fk('tracks', 'artist_id', 'artists', 'restrict');
select pg_temp.replace_fk('albums', 'artist_id', 'artists', 'restrict');

-- =============================================================================
-- 2. Cycle de vie d'un morceau, imposé en base
-- =============================================================================

-- L'API fait déjà ces contrôles (et répond proprement) ; ces triggers sont le
-- filet de sécurité : un bug, un appel direct ou une requête SQL manuelle ne
-- peuvent pas les contourner.
create or replace function tracks_lifecycle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    -- Un morceau publié (ou qui l'a été) a pu être écouté : on l'archive, on ne
    -- le « dépublie » pas — y compris via publié -> archivé -> brouillon.
    if (old.status = 'published' or old.published_at is not null)
       and new.status not in ('published', 'archived') then
      raise exception 'A track that was published cannot go back to %; archive it instead', new.status
        using errcode = '23514';
    end if;

    -- La date de première publication est définitive.
    if old.published_at is not null and new.published_at is distinct from old.published_at then
      raise exception 'published_at cannot be changed once set'
        using errcode = '23514';
    end if;
  end if;

  -- Passage à « published » : les conditions minimales pour pouvoir être écouté
  -- et comptabilisé (une écoute qualifiée dépend de la durée du morceau).
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    if new.duration_seconds is null or new.duration_seconds <= 0 then
      raise exception 'A track needs a duration before it can be published'
        using errcode = '23514';
    end if;

    -- À l'INSERT, aucun fichier ne peut encore exister : contrôlé seulement
    -- quand un morceau existant est publié.
    if tg_op = 'UPDATE' and not exists (select 1 from track_files where track_id = new.id) then
      raise exception 'A track needs an audio file before it can be published'
        using errcode = '23514';
    end if;

    new.published_at := coalesce(new.published_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists tracks_lifecycle on tracks;
create trigger tracks_lifecycle
  before insert or update on tracks
  for each row execute function tracks_lifecycle();

-- Seul un brouillon jamais publié peut être supprimé.
create or replace function tracks_no_delete_published()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status <> 'draft' or old.published_at is not null then
    raise exception 'Only a draft that was never published can be deleted; archive the track instead'
      using errcode = '23001';
  end if;
  return old;
end;
$$;

drop trigger if exists tracks_no_delete_published on tracks;
create trigger tracks_no_delete_published
  before delete on tracks
  for each row execute function tracks_no_delete_published();

-- =============================================================================
-- 3. Colonnes manquantes et contraintes de forme
-- =============================================================================

-- Qui a publié, et fichier mesuré plutôt que déclaré par le client : renseignés
-- par la route d'administration et l'étape de vérification à venir.
alter table tracks add column if not exists published_by uuid references users(id) on delete set null;
alter table track_files add column if not exists duration_seconds integer;
alter table track_files add column if not exists verified_at timestamptz;

-- NOT VALID : contrôle les nouvelles lignes sans bloquer sur d'éventuelles
-- données historiques (à valider plus tard : alter table ... validate constraint).
alter table tracks drop constraint if exists tracks_duration_positive;
alter table tracks add constraint tracks_duration_positive
  check (duration_seconds is null or duration_seconds > 0) not valid;

alter table track_files drop constraint if exists track_files_duration_positive;
alter table track_files add constraint track_files_duration_positive
  check (duration_seconds is null or duration_seconds > 0) not valid;

-- ISRC : 2 lettres (pays) + 3 caractères (émetteur) + 2 chiffres (année) + 5 chiffres.
alter table tracks drop constraint if exists tracks_isrc_format;
alter table tracks add constraint tracks_isrc_format
  check (isrc is null or isrc ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$') not valid;
create unique index if not exists idx_tracks_isrc_unique on tracks (isrc) where isrc is not null;

-- =============================================================================
-- Vérification après application (à lancer à la main) :
--
--   select c.conrelid::regclass as "table", a.attname as "colonne",
--          c.confrelid::regclass as "référence",
--          case c.confdeltype when 'a' then 'no action' when 'r' then 'restrict'
--                             when 'c' then 'cascade'   when 'n' then 'set null' end as on_delete
--   from pg_constraint c
--   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
--   where c.contype = 'f' and c.conrelid::regclass::text in
--     ('listening_sessions','subscriptions','royalty_allocations','creator_wallets',
--      'payouts','tracks','albums')
--   order by 1, 2;
-- =============================================================================
