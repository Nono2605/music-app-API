-- Acceptation des CGU créateur + réponses au questionnaire d'onboarding,
-- capturées au moment où un compte passe en rôle "creator" (POST /creator/apply).
-- Une ligne par créateur (peut être mise à jour si le questionnaire évolue).

create table if not exists creator_onboarding (
  user_id             uuid primary key references users(id) on delete cascade,
  terms_version       text not null,
  terms_accepted_at   timestamptz not null default now(),
  content_provenance  provenance_type not null,
  owns_rights         boolean not null,
  primary_genre       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger creator_onboarding_set_updated_at before update on creator_onboarding
  for each row execute function set_updated_at();

alter table creator_onboarding enable row level security;
