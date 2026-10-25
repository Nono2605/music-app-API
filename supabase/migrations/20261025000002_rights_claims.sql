-- Signalements des ayants droit (formulaire de retrait) et liste de blocage des fichiers retirés
-- (spec 15.3, contrôle C4 ; 15.5, D1 et D8).
--
--   1. rights_claims   un signalement : qui le fait, quelle œuvre, quel morceau de Vynl, et la suite que l'administration
--                      lui donne (reçu, en cours, fondé, rejeté, retiré). Le texte du signalement ne se modifie plus
--                      une fois reçu (c'est une pièce) ; une décision prise est définitive.
--   2. blocked_files   les empreintes SHA-256 des fichiers de morceaux retirés à la suite d'un signalement fondé :
--                      l'API refuse qu'un artiste les renvoie (route d'envoi des fichiers).
--   3. uphold_rights_claim()  la décision « fondé », EN UNE SEULE transaction : le morceau est archivé, ses fichiers
--                      sont bloqués, le signalement est clos. Tout ou rien.
--
-- Rien n'est supprimé : le morceau est archivé (pas effacé), les fichiers restent dans le stockage, les écoutes et
-- l'historique aussi. Un blocage se lève par une simple suppression de ligne dans blocked_files (action de l'admin).
--
-- Les adresses e-mail des demandeurs sont des données personnelles : à citer dans la politique de confidentialité
-- (durée de conservation à fixer avec le juriste). Aucune de ces tables n'est lisible par les comptes de l'application :
-- sécurité par ligne sans politique, seule la clé secrète y accède (l'API et l'admin).
--
-- Prérequis : la table tracks, track_files (colonne checksum), artists et users. Idempotente.

-- 1. Les signalements -------------------------------------------------------------------------------------------------

create table if not exists rights_claims (
  id                    uuid primary key default gen_random_uuid(),
  -- Numéro de dossier donné au demandeur : « RC-00012 » (voir claimReference dans l'API et l'admin).
  claim_number          bigint generated always as identity,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  claimant_name         text not null check (char_length(claimant_name) between 1 and 120),
  claimant_email        text not null check (char_length(claimant_email) between 3 and 254 and claimant_email like '%_@_%.__%'),
  claimant_organization text check (claimant_organization is null or char_length(claimant_organization) between 1 and 120),
  -- Titulaire des droits, mandataire d'un titulaire, ou artiste dont la voix ou l'image est imitée.
  capacity              text not null check (capacity in ('owner', 'agent', 'performer')),
  -- Enregistrement copié, composition (mélodie, paroles), voix ou image imitée, nom ou marque, autre.
  claim_type            text not null check (claim_type in ('recording', 'composition', 'voice_or_likeness', 'name_or_trademark', 'other')),
  -- Le morceau visé sur Vynl : une adresse, ou un titre et un artiste (texte libre).
  track_reference       text not null check (char_length(track_reference) between 1 and 500),
  -- L'œuvre d'origine et où la trouver.
  original_work         text not null check (char_length(original_work) between 1 and 2000),
  description           text not null check (char_length(description) between 20 and 4000),
  -- « Je déclare de bonne foi que ces informations sont exactes et que je suis en droit d'agir. »
  good_faith_statement  boolean not null check (good_faith_statement),

  status                text not null default 'received' check (status in ('received', 'in_review', 'upheld', 'rejected', 'withdrawn')),
  -- Renseignés par l'administration : le morceau identifié, son artiste (retenu au moment de la décision, il survit à
  -- la suppression du morceau), la note interne, qui a décidé et quand.
  track_id              uuid references tracks(id) on delete set null,
  artist_id             uuid references artists(id) on delete set null,
  decision_note         text check (decision_note is null or char_length(decision_note) <= 2000),
  decided_by            uuid references users(id) on delete set null,
  decided_at            timestamptz,
  constraint rights_claims_decided_together check ((status in ('upheld', 'rejected', 'withdrawn')) = (decided_at is not null))
);

create index if not exists idx_rights_claims_status on rights_claims (status, created_at desc);
create index if not exists idx_rights_claims_artist on rights_claims (artist_id) where artist_id is not null;
create index if not exists idx_rights_claims_track on rights_claims (track_id) where track_id is not null;

-- Un signalement naît « reçu » ; son texte ne change plus ; une décision prise est définitive (les liens vers un morceau,
-- un artiste ou un compte supprimés se vident, rien d'autre ne bouge).
create or replace function rights_claims_guard() returns trigger
  language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'received' then
      raise exception 'A rights claim starts as received' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id <> old.id
     or new.claim_number <> old.claim_number
     or new.created_at <> old.created_at
     or new.claimant_name <> old.claimant_name
     or new.claimant_email <> old.claimant_email
     or new.claimant_organization is distinct from old.claimant_organization
     or new.capacity <> old.capacity
     or new.claim_type <> old.claim_type
     or new.track_reference <> old.track_reference
     or new.original_work <> old.original_work
     or new.description <> old.description
     or new.good_faith_statement <> old.good_faith_statement then
    raise exception 'The text of a rights claim cannot be changed' using errcode = '23514';
  end if;

  if old.status in ('upheld', 'rejected', 'withdrawn') then
    -- Seule exception : la base qui vide un lien devenu sans objet (morceau, artiste ou compte supprimé : « on delete
    -- set null »). Tout le reste est figé.
    if (to_jsonb(new) - 'track_id' - 'artist_id' - 'decided_by' - 'updated_at')
         is distinct from (to_jsonb(old) - 'track_id' - 'artist_id' - 'decided_by' - 'updated_at')
       or (new.track_id is distinct from old.track_id and new.track_id is not null)
       or (new.artist_id is distinct from old.artist_id and new.artist_id is not null)
       or (new.decided_by is distinct from old.decided_by and new.decided_by is not null) then
      raise exception 'A decided rights claim cannot be changed' using errcode = '23514';
    end if;
    new.updated_at := old.updated_at;
    return new;
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists rights_claims_guard on rights_claims;
create trigger rights_claims_guard before insert or update on rights_claims
  for each row execute function rights_claims_guard();

-- 2. La liste de blocage ----------------------------------------------------------------------------------------------

create table if not exists blocked_files (
  id         uuid primary key default gen_random_uuid(),
  checksum   text not null unique check (checksum ~ '^[0-9a-f]{64}$'),
  claim_id   uuid references rights_claims(id) on delete set null,
  -- Le morceau dont le fichier a été retiré (sans clé étrangère : la ligne doit survivre à sa suppression).
  track_id   uuid,
  reason     text not null check (char_length(reason) between 1 and 500),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_blocked_files_claim on blocked_files (claim_id) where claim_id is not null;

-- 3. La décision « fondé », en une transaction -----------------------------------------------------------------------

-- Archive le morceau, bloque les empreintes de ses fichiers, clôt le signalement. Rend le nombre de fichiers bloqués et
-- le nombre de fichiers SANS empreinte (envoyés avant la mesure automatique : ils ne peuvent pas être bloqués, à
-- rattraper avec `npm run backfill:audio`).
create or replace function uphold_rights_claim(p_claim uuid, p_admin uuid, p_track uuid, p_note text default null)
  returns table (files_blocked integer, files_without_checksum integer)
  language plpgsql as $$
declare
  v_claim rights_claims%rowtype;
  v_track tracks%rowtype;
  v_blocked integer;
  v_unhashed integer;
begin
  select * into v_claim from rights_claims where id = p_claim for update;
  if not found then raise exception 'Rights claim not found' using errcode = 'P0002'; end if;
  if v_claim.status in ('upheld', 'rejected', 'withdrawn') then
    raise exception 'This rights claim is already decided' using errcode = '23514';
  end if;

  select * into v_track from tracks where id = p_track for update;
  if not found then raise exception 'Track not found' using errcode = 'P0002'; end if;

  if v_track.status <> 'archived' then
    -- Le motif est lu par le créateur : neutre, sans nommer le demandeur.
    update tracks set status = 'archived', rejection_reason = 'Removed following a rights holder claim.' where id = v_track.id;
  end if;

  insert into blocked_files (checksum, claim_id, track_id, reason, created_by)
  select distinct f.checksum, v_claim.id, v_track.id, 'Rights claim #' || v_claim.claim_number, p_admin
    from track_files f
   where f.track_id = v_track.id and f.checksum is not null
  on conflict (checksum) do nothing;
  get diagnostics v_blocked = row_count;

  select count(*) into v_unhashed from track_files where track_id = v_track.id and checksum is null;

  update rights_claims
     set status = 'upheld', track_id = v_track.id, artist_id = v_track.artist_id,
         decided_by = p_admin, decided_at = now(), decision_note = p_note
   where id = v_claim.id;

  return query select v_blocked, v_unhashed;
end $$;

-- Droits : réservé à la clé secrète (l'API et l'admin).
alter table rights_claims enable row level security;
alter table blocked_files enable row level security;
revoke all on rights_claims, blocked_files from anon, authenticated;

revoke all on function uphold_rights_claim(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function rights_claims_guard() from public, anon, authenticated;
grant execute on function uphold_rights_claim(uuid, uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
