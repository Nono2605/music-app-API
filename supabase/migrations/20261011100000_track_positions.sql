-- Position d'un morceau dans sa release (`tracks.track_number`) : renseignée
-- automatiquement et reprise pour les morceaux existants.
--
-- Jusqu'ici la colonne n'était jamais écrite : la page d'une release affichait un
-- rang calculé à la volée, et l'administration, « Track number : — ». À ne pas
-- confondre avec le NUMÉRO DE CATALOGUE (`catalog_number` / `catalog_code`,
-- VYN-T-000005), permanent et propre à chaque morceau.
--
-- Règles, imposées par la base (donc valables pour le Studio, l'API, l'admin et
-- toute requête manuelle) :
--   * un morceau qui entre dans une release prend la position suivante (max + 1) ;
--   * un morceau SEUL (sans release) est la piste 1 de lui-même : ainsi un single
--     affiche « 1 », et le futur parcours « single » (une release de type single à un
--     morceau) donnera le même résultat ;
--   * une position fournie explicitement dans la même release est respectée (réorganiser
--     l'ordre des pistes) ;
--   * quand un morceau quitte une release (retiré, déplacé ou supprimé), les pistes
--     restantes sont renumérotées sans trou : 1, 2, 3, jamais 1, 3.
--   * une position est un entier >= 1.
--
-- Reprise de l'existant : chaque release est renumérotée de 1 à n (positions déjà posées
-- d'abord, puis les autres par date de création) ; morceaux seuls = 1. `updated_at`
-- n'est PAS modifié (ce n'est pas une modification de l'artiste).
--
-- Idempotente. Prérequis : 20261011000000_catalog_numbers_and_artist_names.sql
-- (pas techniquement, mais c'est l'ordre prévu).

begin;

-- =============================================================================
-- 1. Renumérotation d'une release (sert à la reprise ET quand un morceau la quitte)
-- =============================================================================

-- Pistes de 1 à n sans trou. Ordre conservé : celles qui ont déjà une position d'abord
-- (dans cet ordre), puis les autres par date de création.
create or replace function public.compact_album_positions(p_album uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  update public.tracks t
     set track_number = r.n
    from (
      select id, row_number() over (order by track_number nulls last, created_at, id) as n
        from public.tracks
       where album_id = p_album
    ) r
   where t.id = r.id and t.track_number is distinct from r.n;
end;
$$;

-- =============================================================================
-- 2. Reprise des morceaux existants
-- =============================================================================

alter table public.tracks disable trigger tracks_set_updated_at;

select public.compact_album_positions(id) from public.albums;
update public.tracks set track_number = 1 where album_id is null and track_number is null;

alter table public.tracks enable trigger tracks_set_updated_at;

-- =============================================================================
-- 3. Une position est un entier >= 1
-- =============================================================================

alter table public.tracks drop constraint if exists tracks_track_number_positive;
alter table public.tracks add constraint tracks_track_number_positive
  check (track_number is null or track_number >= 1);

-- =============================================================================
-- 4. Attribution automatique
-- =============================================================================

create or replace function public.tracks_assign_position()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  nxt integer;
begin
  if new.album_id is null then
    new.track_number := 1;
    return new;
  end if;

  -- Position fournie, dans la même release : on la respecte (réorganisation).
  if new.track_number is not null
     and (tg_op = 'INSERT' or new.album_id is not distinct from old.album_id) then
    return new;
  end if;

  -- Deux ajouts simultanés dans la même release ne doivent pas prendre le même rang.
  perform pg_advisory_xact_lock(hashtextextended('track_position:' || new.album_id::text, 0));
  select coalesce(max(track_number), 0) + 1
    into nxt
    from public.tracks
   where album_id = new.album_id and id <> new.id;
  new.track_number := nxt;
  return new;
end;
$$;

drop trigger if exists tracks_assign_position on public.tracks;
create trigger tracks_assign_position
  before insert or update of album_id, track_number on public.tracks
  for each row execute function public.tracks_assign_position();

-- =============================================================================
-- 5. Renumérotation quand un morceau quitte une release
-- =============================================================================

create or replace function public.tracks_compact_after_leave()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- La renumération elle-même met des morceaux à jour : on ne rebondit pas.
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.album_id is not null then
      perform public.compact_album_positions(old.album_id);
    end if;
  elsif old.album_id is not null and new.album_id is distinct from old.album_id then
    perform public.compact_album_positions(old.album_id);
  end if;
  return null;
end;
$$;

drop trigger if exists tracks_compact_positions on public.tracks;
create trigger tracks_compact_positions
  after update of album_id or delete on public.tracks
  for each row execute function public.tracks_compact_after_leave();

commit;
