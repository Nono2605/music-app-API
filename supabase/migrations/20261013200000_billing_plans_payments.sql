-- Argent entrant : plans, clients de facturation, paiements et événements Stripe
-- (docs/SPEC_REMUNERATION.md, section 7.2, étape 3 « Argent entrant »).
--
-- Décisions du 12 oct. 2026 : devise CHF ; un plan « Premium » à 10 CHF par mois, TTC (le prix
-- affiché inclut la taxe : le net varie selon le pays de l'acheteur) ; un plan gratuit sans
-- Stripe (publicité, après la bêta). Rien ici ne change qui a accès à quoi : le droit d'écoute
-- reste « beta » tant que ENTITLEMENT_MODE n'est pas « live ».
--
-- 1. plans             : les offres. Le prix d'un plan relié à Stripe ne se modifie plus (un prix
--                        Stripe est immuable) : un nouveau prix = un nouveau plan.
-- 2. billing_customers : le lien compte Vynl ↔ client Stripe.
-- 3. subscriptions     : on ajoute seulement un index unique sur l'identifiant Stripe.
-- 4. payments          : un paiement encaissé (une ligne par facture Stripe payée). Pièce
--                        comptable : jamais supprimée, ses montants ne changent plus ; seuls les
--                        frais (une fois connus) et les remboursements évoluent.
-- 5. stripe_events     : chaque événement reçu, une seule fois (idempotence) et son issue.
--
-- Montants RÉELS encaissés : en centimes (`_cents`), comme le veut la décision D10 de la spec.
-- Idempotente (rejouable). Prérequis : le schéma initial (users, subscriptions, set_updated_at).
-- À appliquer dans le SQL Editor de Supabase AVANT d'utiliser la facturation de l'API.

-- =============================================================================
-- 1. Plans
-- =============================================================================

create table if not exists plans (
  code              text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name              text not null,
  price_cents       integer not null check (price_cents >= 0),
  -- Code ISO 4217 en minuscules, comme Stripe (« chf »).
  currency          text not null check (currency ~ '^[a-z]{3}$'),
  interval          text not null check (interval in ('month', 'year')),
  -- Le niveau gratuit est un plan à 0 avec publicité (spec section 7.2).
  ad_supported      boolean not null default false,
  -- Le prix affiché est-il TTC (« inclusive ») ou HT (« exclusive ») ? Vynl : TTC.
  tax_behavior      text not null default 'inclusive' check (tax_behavior in ('inclusive', 'exclusive')),
  active            boolean not null default true,
  stripe_product_id text,
  stripe_price_id   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table plans enable row level security;

-- Un plan relié à Stripe : son prix, sa devise, sa période et sa taxe ne changent plus (le prix
-- Stripe, lui, est immuable) ; les identifiants Stripe, une fois posés, non plus.
create or replace function plans_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.stripe_price_id is not null and (
       new.price_cents is distinct from old.price_cents
    or new.currency is distinct from old.currency
    or new.interval is distinct from old.interval
    or new.tax_behavior is distinct from old.tax_behavior
  ) then
    raise exception 'A plan already linked to Stripe cannot change its price: create a new plan'
      using errcode = '23514';
  end if;

  if (old.stripe_price_id is not null and new.stripe_price_id is distinct from old.stripe_price_id)
     or (old.stripe_product_id is not null and new.stripe_product_id is distinct from old.stripe_product_id) then
    raise exception 'The Stripe identifiers of a plan cannot change once set'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists plans_guard on plans;
create trigger plans_guard before update on plans for each row execute function plans_guard();

drop trigger if exists plans_set_updated_at on plans;
create trigger plans_set_updated_at before update on plans for each row execute function set_updated_at();

-- Les deux offres de départ (ne remplace rien si elles existent déjà).
insert into plans (code, name, price_cents, currency, interval, ad_supported, tax_behavior) values
  ('free',    'Free',    0,    'chf', 'month', true,  'inclusive'),
  ('premium', 'Premium', 1000, 'chf', 'month', false, 'inclusive')
on conflict (code) do nothing;

-- =============================================================================
-- 2. Clients de facturation
-- =============================================================================

create table if not exists billing_customers (
  user_id              uuid primary key references users(id) on delete cascade,
  provider             text not null default 'stripe',
  provider_customer_id text not null unique,
  created_at           timestamptz not null default now()
);

alter table billing_customers enable row level security;

-- =============================================================================
-- 3. Abonnements : un abonnement Stripe = une ligne
-- =============================================================================

create unique index if not exists idx_subscriptions_provider_subscription
  on subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;

-- =============================================================================
-- 4. Paiements
-- =============================================================================

create table if not exists payments (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid references users(id) on delete set null,
  subscription_id      uuid references subscriptions(id) on delete set null,
  provider             text not null default 'stripe',
  -- L'identifiant de la FACTURE Stripe (in_…) : une facture payée = un paiement.
  provider_payment_id  text not null,
  provider_charge_id   text,
  -- Le plan au moment du paiement (copie : renommer ou changer un plan ne réécrit pas l'histoire).
  plan                 text,
  currency             text not null check (currency ~ '^[a-z]{3}$'),
  -- Ce que le client a payé, taxe comprise.
  gross_cents          bigint not null check (gross_cents >= 0),
  -- La part de taxe (TVA) : n'appartient à personne, ni à Vynl ni aux artistes (spec Q1).
  tax_cents            bigint not null default 0 check (tax_cents >= 0),
  -- Frais de Stripe : inconnus au moment du paiement, posés ensuite.
  fee_cents            bigint check (fee_cents >= 0),
  refunded_cents       bigint not null default 0 check (refunded_cents >= 0),
  status               text not null default 'paid' check (status in ('paid', 'partially_refunded', 'refunded')),
  -- La période de service couverte (sert à rattacher l'argent à un mois, spec section 9).
  service_period_start timestamptz,
  service_period_end   timestamptz,
  paid_at              timestamptz not null,
  created_at           timestamptz not null default now(),
  -- La base de calcul des parts (spec Q1) : le montant payé HORS taxe.
  amount_excl_tax_cents bigint generated always as (gross_cents - tax_cents) stored,
  -- Ce qui reste une fois taxe ET frais retirés ; inconnu tant que les frais le sont.
  net_cents            bigint generated always as (
                         case when fee_cents is null then null else gross_cents - tax_cents - fee_cents end
                       ) stored,
  constraint payments_tax_within_gross check (tax_cents <= gross_cents),
  constraint payments_refund_within_gross check (refunded_cents <= gross_cents),
  unique (provider, provider_payment_id)
);

create index if not exists idx_payments_user on payments (user_id, paid_at desc);
create index if not exists idx_payments_paid_at on payments (paid_at desc);
create unique index if not exists idx_payments_charge on payments (provider, provider_charge_id) where provider_charge_id is not null;

alter table payments enable row level security;

-- Pièce comptable : jamais supprimée ; les montants encaissés ne changent plus. Évoluent seulement
-- les frais (une fois, de « inconnu » à une valeur), les remboursements (qui ne font qu'augmenter),
-- le statut et l'identifiant de charge (de « inconnu » à une valeur). La suppression d'un compte
-- détache le paiement (user_id, subscription_id passent à null) sans toucher à l'argent.
create or replace function payments_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payments are accounting records and cannot be deleted' using errcode = '23514';
  end if;

  if new.provider is distinct from old.provider
     or new.provider_payment_id is distinct from old.provider_payment_id
     or new.plan is distinct from old.plan
     or new.currency is distinct from old.currency
     or new.gross_cents is distinct from old.gross_cents
     or new.tax_cents is distinct from old.tax_cents
     or new.paid_at is distinct from old.paid_at
     or new.service_period_start is distinct from old.service_period_start
     or new.service_period_end is distinct from old.service_period_end then
    raise exception 'The amounts and references of a payment cannot be modified' using errcode = '23514';
  end if;

  if new.fee_cents is distinct from old.fee_cents and old.fee_cents is not null then
    raise exception 'The fee of a payment can only be set once' using errcode = '23514';
  end if;

  if new.refunded_cents < old.refunded_cents then
    raise exception 'A refund cannot be reduced' using errcode = '23514';
  end if;

  if new.provider_charge_id is distinct from old.provider_charge_id and old.provider_charge_id is not null then
    raise exception 'The charge of a payment cannot change once set' using errcode = '23514';
  end if;

  -- user_id / subscription_id : seulement vers null (compte ou abonnement supprimé).
  if (new.user_id is distinct from old.user_id and new.user_id is not null)
     or (new.subscription_id is distinct from old.subscription_id and new.subscription_id is not null) then
    raise exception 'A payment cannot be reassigned to another account' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists payments_guard on payments;
create trigger payments_guard before update or delete on payments for each row execute function payments_guard();

-- =============================================================================
-- 5. Événements Stripe reçus
-- =============================================================================

create table if not exists stripe_events (
  id                  text primary key,
  type                text not null,
  livemode            boolean not null,
  provider_created_at timestamptz not null,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  -- received : reçu, pas encore traité ; processed : traité ; ignored : type qui ne nous concerne
  -- pas ; failed : le traitement a échoué (Stripe réessaiera ; l'erreur est gardée pour le diagnostic).
  outcome             text not null default 'received' check (outcome in ('received', 'processed', 'ignored', 'failed')),
  error               text
);

create index if not exists idx_stripe_events_received on stripe_events (received_at desc);

alter table stripe_events enable row level security;

-- Demande à l'API de Supabase (PostgREST) de relire le schéma.
notify pgrst, 'reload schema';

-- =============================================================================
-- Vérification après application (à lancer à la main) :
--
--   select code, name, price_cents, currency, interval, tax_behavior from plans order by code;
--   -- free 0 chf, premium 1000 chf month inclusive
--   select count(*) from payments;      -- 0 au départ
-- =============================================================================
