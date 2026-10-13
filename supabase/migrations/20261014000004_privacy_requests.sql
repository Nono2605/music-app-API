-- Registre des demandes de droits des personnes (export de ses données, suppression de son compte) :
-- de quoi montrer qu'elles sont traitées (nLPD, RGPD : responsabilité de rendre des comptes).
--
-- Une ligne par demande TRAITÉE (ou échouée) : le genre, l'issue, le moment, et un détail technique sans
-- donnée personnelle (par exemple le nombre d'abonnements annulés). Pour une suppression, user_id reste
-- vide : le compte n'existe plus, c'est voulu. Pour un export, user_id pointe le compte, et passe à null
-- si le compte est supprimé ensuite.
--
-- Pièce de preuve : on n'y modifie rien et on n'y supprime rien (seul le passage de user_id à null, fait
-- par la base à la suppression d'un compte, est permis). Écriture « au mieux » côté API : sans cette table
-- (migration pas appliquée), l'export et la suppression fonctionnent quand même.
--
-- Idempotente (rejouable). Prérequis : le schéma initial (users).

create table if not exists privacy_requests (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('export', 'deletion')),
  status       text not null check (status in ('completed', 'failed')),
  user_id      uuid references users(id) on delete set null,
  detail       jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists idx_privacy_requests_kind on privacy_requests (kind, created_at desc);

alter table privacy_requests enable row level security;

create or replace function privacy_requests_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'privacy request records cannot be deleted' using errcode = '23514';
  end if;

  -- Seul changement permis : user_id vers null (suppression du compte).
  if new.kind is distinct from old.kind
     or new.status is distinct from old.status
     or new.detail is distinct from old.detail
     or new.completed_at is distinct from old.completed_at
     or new.created_at is distinct from old.created_at
     or (new.user_id is distinct from old.user_id and new.user_id is not null) then
    raise exception 'privacy request records cannot be modified' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists privacy_requests_guard on privacy_requests;
create trigger privacy_requests_guard before update or delete on privacy_requests
  for each row execute function privacy_requests_guard();

-- Demande à l'API de Supabase (PostgREST) de relire le schéma.
notify pgrst, 'reload schema';

-- Vérification après application (à lancer à la main) :
--   select count(*) from privacy_requests;       -- 0 au départ
