-- Statistiques de lecture côté créateur (docs/SPEC_REMUNERATION.md, étape 2 :
-- « statistiques de lecture côté créateur »).
--
-- Quatre fonctions en LECTURE SEULE qui agrègent `plays` en SQL pour l'artiste
-- demandé. Elles remplacent l'agrégation en JavaScript des routes /creator/audience
-- et /creator/analytics, qui ne tient pas sur `plays` : PostgREST plafonne une
-- requête à 1 000 lignes, un décompte fait côté API serait silencieusement faux.
--
-- Définitions (les mêmes partout, pour que les chiffres s'accordent) :
--   * une écoute = une ligne de `plays` comptée (`counted`) ET qualifiée
--     (`qualified`, soit 30 s validées, spec D1) ; `starts` = lectures démarrées,
--     qualifiées ou non, comptées seulement ;
--   * auditeurs uniques = comptes distincts (`user_id`) parmi les écoutes. Un compte
--     supprimé est anonymisé (user_id = null, migration d'intégrité) : il ne compte
--     plus comme auditeur, mais ses écoutes restent comptées ;
--   * secondes = `validated_seconds` des écoutes qualifiées (mesurées par le
--     serveur, jamais déclarées par le client) ;
--   * jours en UTC, comme les périodes de la spec ;
--   * aucune distinction de `entitlement` : ce sont des statistiques d'écoute, pas
--     de revenu (pendant la bêta tout est « beta »).
--
-- Fenêtre : [p_from, p_to[ (borne haute exclue). `p_track_id` restreint à un morceau.
--
-- Sécurité : les tables ont la RLS sans policy ; ces fonctions ne sont donc
-- appelables que par la clé service_role de l'API. On retire explicitement
-- l'exécution à public / anon / authenticated, sans quoi PostgREST les exposerait
-- à tout porteur de la clé publique. L'API vérifie que l'artiste est celui du
-- compte connecté AVANT d'appeler : ces fonctions font confiance à p_artist_id.
--
-- Idempotente (create or replace). Aucune table modifiée.

-- =============================================================================
-- 1. Totaux de la fenêtre
-- =============================================================================

create or replace function creator_stats_totals(
  p_artist_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_track_id uuid default null
)
returns table (
  plays bigint,
  starts bigint,
  listeners bigint,
  seconds numeric,
  saves bigint,
  new_followers bigint
)
language sql
stable
set search_path = public
as $$
  with p as (
    select user_id, qualified, validated_seconds
    from plays
    where artist_id = p_artist_id
      and counted
      and started_at >= p_from and started_at < p_to
      and (p_track_id is null or track_id = p_track_id)
  )
  select
    (select count(*) from p where qualified),
    (select count(*) from p),
    (select count(distinct user_id) from p where qualified),
    coalesce((select sum(validated_seconds) from p where qualified), 0),
    -- Sauvegardes : ajouts à la bibliothèque d'un morceau de l'artiste.
    (
      select count(*)
      from library l
      join tracks t on t.id = l.item_id
      where l.item_type = 'track'
        and t.artist_id = p_artist_id
        and (p_track_id is null or t.id = p_track_id)
        and l.added_at >= p_from and l.added_at < p_to
    ),
    (
      select count(*)
      from follows f
      where f.artist_id = p_artist_id
        and f.created_at >= p_from and f.created_at < p_to
    );
$$;

-- =============================================================================
-- 2. Série journalière (les jours sans écoute sont présents, à zéro)
-- =============================================================================

create or replace function creator_stats_daily(
  p_artist_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_track_id uuid default null
)
returns table (
  day date,
  plays bigint,
  listeners bigint,
  seconds numeric
)
language sql
stable
set search_path = public
as $$
  with days as (
    -- timestamp sans fuseau : le ::date reste celui du jour UTC quel que soit le
    -- fuseau de la session.
    select d::date as day
    from generate_series(
      (p_from at time zone 'UTC')::date::timestamp,
      ((p_to at time zone 'UTC') - interval '1 microsecond')::date::timestamp,
      interval '1 day'
    ) d
  ),
  agg as (
    select
      (started_at at time zone 'UTC')::date as day,
      count(*) as n_plays,
      count(distinct user_id) as n_listeners,
      sum(validated_seconds) as n_seconds
    from plays
    where artist_id = p_artist_id
      and counted and qualified
      and started_at >= p_from and started_at < p_to
      and (p_track_id is null or track_id = p_track_id)
    group by 1
  )
  select d.day, coalesce(a.n_plays, 0), coalesce(a.n_listeners, 0), coalesce(a.n_seconds, 0)
  from days d
  left join agg a using (day)
  order by d.day;
$$;

-- =============================================================================
-- 3. Morceaux les plus écoutés
-- =============================================================================

create or replace function creator_stats_top_tracks(
  p_artist_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 10
)
returns table (
  track_id uuid,
  title text,
  plays bigint,
  listeners bigint,
  seconds numeric
)
language sql
stable
set search_path = public
as $$
  select
    p.track_id,
    t.title,
    count(*),
    count(distinct p.user_id),
    coalesce(sum(p.validated_seconds), 0)
  from plays p
  join tracks t on t.id = p.track_id
  where p.artist_id = p_artist_id
    and p.counted and p.qualified
    and p.started_at >= p_from and p.started_at < p_to
  group by p.track_id, t.title
  -- track_id en dernier critère : un classement identique d'un appel à l'autre.
  order by count(*) desc, coalesce(sum(p.validated_seconds), 0) desc, p.track_id
  limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

-- =============================================================================
-- 4. Répartition : d'où, d'où vient la lecture, sur quel appareil
-- =============================================================================

create or replace function creator_stats_breakdown(
  p_artist_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_track_id uuid default null
)
returns table (
  dimension text,
  key text,
  plays bigint,
  seconds numeric
)
language sql
stable
set search_path = public
as $$
  with p as (
    select
      coalesce(source_context, 'unknown') as src,
      coalesce(country_code, 'unknown') as country,
      coalesce(device_type, 'unknown') as device,
      validated_seconds
    from plays
    where artist_id = p_artist_id
      and counted and qualified
      and started_at >= p_from and started_at < p_to
      and (p_track_id is null or track_id = p_track_id)
  )
  select 'source'::text, src, count(*), coalesce(sum(validated_seconds), 0) from p group by src
  union all
  select 'country'::text, country, count(*), coalesce(sum(validated_seconds), 0) from p group by country
  union all
  select 'device'::text, device, count(*), coalesce(sum(validated_seconds), 0) from p group by device
  order by 1, 3 desc, 2;
$$;

-- =============================================================================
-- 5. Droits d'exécution : service_role uniquement
-- =============================================================================

revoke all on function creator_stats_totals(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function creator_stats_daily(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function creator_stats_top_tracks(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
revoke all on function creator_stats_breakdown(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;

grant execute on function creator_stats_totals(uuid, timestamptz, timestamptz, uuid) to service_role;
grant execute on function creator_stats_daily(uuid, timestamptz, timestamptz, uuid) to service_role;
grant execute on function creator_stats_top_tracks(uuid, timestamptz, timestamptz, integer) to service_role;
grant execute on function creator_stats_breakdown(uuid, timestamptz, timestamptz, uuid) to service_role;
