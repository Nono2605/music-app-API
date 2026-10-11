import type Stripe from "stripe";
import { env } from "../config/env";
import {
  checkoutUrls,
  idOf,
  invoiceSubscriptionId,
  invoiceToPayment,
  mapSubscriptionStatus,
  paymentStatus,
  subscriptionPeriod,
  subscriptionPriceId,
} from "./billingMap";
import { getStripe } from "./stripe";
import { supabaseAdmin } from "./supabaseAdmin";

// Facturation : plans, paiement (Stripe Checkout), portail client, et traitement des événements
// de Stripe. Règle de fond : un événement ne sert que de DÉCLENCHEUR ; on relit l'objet auprès de
// Stripe (SDK épinglé) avant d'écrire quoi que ce soit (voir lib/billingMap.ts).

// Le service de paiement n'est pas prêt (clé, adresse de retour, plan non relié) : 503.
export class BillingUnavailableError extends Error {}
// La demande ne peut pas aboutir telle quelle (déjà abonné, pas de compte de facturation) : 409.
export class BillingConflictError extends Error {}
// Plan inconnu ou non vendable : 400.
export class BillingPlanError extends Error {}

export interface PlanRow {
  code: string;
  name: string;
  price_cents: number;
  currency: string;
  interval: string;
  ad_supported: boolean;
  tax_behavior: string;
  active: boolean;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
}

const PLAN_COLUMNS = "code, name, price_cents, currency, interval, ad_supported, tax_behavior, active, stripe_product_id, stripe_price_id";
const UNIQUE_VIOLATION = "23505";

export async function listActivePlans(): Promise<PlanRow[]> {
  const { data, error } = await supabaseAdmin.from("plans").select(PLAN_COLUMNS).eq("active", true).order("price_cents");
  if (error) throw error;
  return (data ?? []) as PlanRow[];
}

async function findPlan(code: string): Promise<PlanRow | null> {
  const { data, error } = await supabaseAdmin.from("plans").select(PLAN_COLUMNS).eq("code", code).maybeSingle();
  if (error) throw error;
  return (data as PlanRow | null) ?? null;
}

async function findPlanByPriceId(priceId: string | null): Promise<PlanRow | null> {
  if (!priceId) return null;
  const { data, error } = await supabaseAdmin.from("plans").select(PLAN_COLUMNS).eq("stripe_price_id", priceId).maybeSingle();
  if (error) throw error;
  return (data as PlanRow | null) ?? null;
}

// --- Plans -> Stripe -------------------------------------------------------------------------

// Crée, dans Stripe, le produit et le prix de chaque plan payant qui n'en a pas encore, et note
// leurs identifiants. Rejouable : un plan déjà relié est sauté, et les clés d'idempotence évitent
// un doublon si l'écriture en base échoue après la création côté Stripe.
export async function syncPlansToStripe(): Promise<{ linked: string[]; alreadyLinked: string[] }> {
  const stripe = getStripe();
  const { data, error } = await supabaseAdmin.from("plans").select(PLAN_COLUMNS).eq("active", true).gt("price_cents", 0);
  if (error) throw error;

  const linked: string[] = [];
  const alreadyLinked: string[] = [];

  for (const plan of (data ?? []) as PlanRow[]) {
    if (plan.stripe_price_id) {
      alreadyLinked.push(plan.code);
      continue;
    }

    const product = await stripe.products.create(
      { name: `Vynl ${plan.name}`, metadata: { plan_code: plan.code } },
      { idempotencyKey: `vynl-product-${plan.code}` }
    );
    const price = await stripe.prices.create(
      {
        product: product.id,
        unit_amount: plan.price_cents,
        currency: plan.currency,
        recurring: { interval: plan.interval as "month" | "year" },
        tax_behavior: plan.tax_behavior as "inclusive" | "exclusive",
        metadata: { plan_code: plan.code },
      },
      { idempotencyKey: `vynl-price-${plan.code}-${plan.price_cents}-${plan.currency}-${plan.interval}-${plan.tax_behavior}` }
    );

    const { error: updateError } = await supabaseAdmin
      .from("plans")
      .update({ stripe_product_id: product.id, stripe_price_id: price.id })
      .eq("code", plan.code)
      .is("stripe_price_id", null);
    if (updateError) throw updateError;
    linked.push(plan.code);
  }

  return { linked, alreadyLinked };
}

// --- Paiement et portail ----------------------------------------------------------------------

async function userIdForCustomer(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const { data, error } = await supabaseAdmin
    .from("billing_customers")
    .select("user_id")
    .eq("provider_customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

async function customerIdForUser(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("billing_customers")
    .select("provider_customer_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.provider_customer_id ?? null;
}

// Le client Stripe de ce compte : relu, sinon créé (une seule fois grâce à la clé d'idempotence).
async function ensureStripeCustomer(userId: string): Promise<string> {
  const existing = await customerIdForUser(userId);
  if (existing) return existing;

  const { data: user, error } = await supabaseAdmin.from("users").select("email").eq("id", userId).single();
  if (error) throw error;

  const customer = await getStripe().customers.create(
    { email: user.email, metadata: { user_id: userId } },
    { idempotencyKey: `vynl-customer-${userId}` }
  );

  const { error: insertError } = await supabaseAdmin
    .from("billing_customers")
    .insert({ user_id: userId, provider_customer_id: customer.id });
  // Une autre requête l'a créé entre-temps : on reprend le sien.
  if (insertError && insertError.code !== UNIQUE_VIOLATION) throw insertError;
  return (await customerIdForUser(userId)) ?? customer.id;
}

// Ce compte a-t-il déjà un abonnement Stripe en cours ?
async function hasLiveSubscription(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("provider", "stripe")
    .in("status", ["active", "trialing", "past_due"])
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

// L'adresse de la page de paiement Stripe pour ce plan.
export async function createCheckout(userId: string, planCode: string): Promise<string> {
  const urls = checkoutUrls(env.checkoutReturnBaseUrl);
  if (!urls) throw new BillingUnavailableError("CHECKOUT_RETURN_BASE_URL is not set");

  const plan = await findPlan(planCode);
  if (!plan || !plan.active || plan.price_cents <= 0) throw new BillingPlanError("This plan cannot be purchased");
  if (!plan.stripe_price_id) throw new BillingUnavailableError("This plan is not linked to Stripe yet");

  if (await hasLiveSubscription(userId)) {
    throw new BillingConflictError("You already have a subscription: manage it from the billing portal");
  }

  const customer = await ensureStripeCustomer(userId);
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: userId,
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    // Le compte et le plan voyagent avec l'abonnement : on sait à qui il est sans dépendre de
    // l'ordre d'arrivée des événements.
    subscription_data: { metadata: { user_id: userId, plan: plan.code } },
    success_url: urls.success,
    cancel_url: urls.cancel,
    // L'adresse de facturation fixe le pays, donc la taxe applicable.
    billing_address_collection: "required",
    ...(env.stripeAutomaticTax ? { automatic_tax: { enabled: true }, customer_update: { address: "auto" as const } } : {}),
  });

  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return session.url;
}

// Le portail client de Stripe : changer de carte, voir les factures, résilier.
export async function createPortal(userId: string): Promise<string> {
  const urls = checkoutUrls(env.checkoutReturnBaseUrl);
  if (!urls) throw new BillingUnavailableError("CHECKOUT_RETURN_BASE_URL is not set");

  const customer = await customerIdForUser(userId);
  if (!customer) throw new BillingConflictError("No billing account yet: subscribe first");

  const session = await getStripe().billingPortal.sessions.create({ customer, return_url: urls.account });
  return session.url;
}

// --- Événements de Stripe -------------------------------------------------------------------

type Outcome = "processed" | "ignored";

async function findSubscriptionRow(providerSubscriptionId: string): Promise<{ id: string; user_id: string | null; plan: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id, user_id, plan")
    .eq("provider", "stripe")
    .eq("provider_subscription_id", providerSubscriptionId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// Écrit (ou met à jour) la ligne `subscriptions` d'un abonnement Stripe, d'après son ÉTAT ACTUEL.
async function syncSubscription(subscriptionId: string): Promise<Outcome> {
  const sub = await getStripe().subscriptions.retrieve(subscriptionId);

  const status = mapSubscriptionStatus(sub.status);
  if (!status) return "ignored"; // premier paiement pas encore réussi

  const customerId = idOf(sub.customer);
  const userId = sub.metadata?.user_id || (await userIdForCustomer(customerId));
  if (!userId) throw new Error(`No Vynl account for subscription ${sub.id}`);

  const plan = await findPlanByPriceId(subscriptionPriceId(sub));
  const period = subscriptionPeriod(sub);
  const row = {
    user_id: userId,
    plan: plan?.code ?? sub.metadata?.plan ?? "unknown",
    status,
    provider: "stripe",
    provider_subscription_id: sub.id,
    current_period_start: period.start,
    current_period_end: period.end,
    cancel_at_period_end: sub.cancel_at_period_end,
  };

  const existing = await findSubscriptionRow(sub.id);
  if (existing) {
    const { error } = await supabaseAdmin.from("subscriptions").update(row).eq("id", existing.id);
    if (error) throw error;
    return "processed";
  }

  const { error } = await supabaseAdmin.from("subscriptions").insert(row);
  if (error?.code === UNIQUE_VIOLATION) {
    // Deux événements pour le même abonnement en même temps : l'autre a gagné, on met à jour.
    const { error: retryError } = await supabaseAdmin
      .from("subscriptions")
      .update(row)
      .eq("provider", "stripe")
      .eq("provider_subscription_id", sub.id);
    if (retryError) throw retryError;
  } else if (error) {
    throw error;
  }
  return "processed";
}

// La charge (et ses frais) derrière une facture payée. Au mieux : un échec ici ne doit pas
// empêcher d'enregistrer le paiement, les frais et la charge se complètent ensuite.
async function fetchChargeAndFee(invoiceId: string): Promise<{ chargeId: string | null; fee: number | null }> {
  try {
    const stripe = getStripe();
    const payments = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 5 });
    const paid = payments.data.find((entry) => entry.status === "paid") ?? payments.data[0];
    const intentId = idOf(paid?.payment?.payment_intent ?? null);
    if (!intentId) return { chargeId: null, fee: null };

    const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge.balance_transaction"] });
    const charge = intent.latest_charge;
    if (!charge || typeof charge === "string") return { chargeId: charge ?? null, fee: null };

    const transaction = charge.balance_transaction;
    return { chargeId: charge.id, fee: transaction && typeof transaction !== "string" ? transaction.fee : null };
  } catch (err) {
    const { type, code } = err as { type?: string; code?: string };
    console.warn(`Could not read the charge and fee of invoice ${invoiceId}: ${type ?? "unknown"} ${code ?? ""}`.trim());
    return { chargeId: null, fee: null };
  }
}

async function recordInvoicePaid(invoiceId: string): Promise<Outcome> {
  const invoice = await getStripe().invoices.retrieve(invoiceId);
  const fields = invoiceToPayment(invoice);
  if (!fields) return "ignored"; // facture à 0 : rien d'encaissé

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("payments")
    .select("id, fee_cents, provider_charge_id")
    .eq("provider", "stripe")
    .eq("provider_payment_id", fields.provider_payment_id)
    .maybeSingle();
  if (lookupError) throw lookupError;

  if (existing) {
    // Déjà enregistré (événement rejoué) : on complète seulement ce qui manquait.
    if (existing.fee_cents === null || existing.provider_charge_id === null) {
      const extra = await fetchChargeAndFee(fields.provider_payment_id);
      const patch: Record<string, unknown> = {};
      if (existing.fee_cents === null && extra.fee !== null) patch.fee_cents = extra.fee;
      if (existing.provider_charge_id === null && extra.chargeId) patch.provider_charge_id = extra.chargeId;
      if (Object.keys(patch).length > 0) {
        const { error } = await supabaseAdmin.from("payments").update(patch).eq("id", existing.id);
        if (error) throw error;
      }
    }
    return "processed";
  }

  const subscriptionId = invoiceSubscriptionId(invoice);
  let subscription = subscriptionId ? await findSubscriptionRow(subscriptionId) : null;
  if (!subscription && subscriptionId) {
    await syncSubscription(subscriptionId);
    subscription = await findSubscriptionRow(subscriptionId);
  }

  const userId = subscription?.user_id ?? (await userIdForCustomer(idOf(invoice.customer)));
  // Pas de compte trouvé : on échoue, Stripe réessaiera (l'événement de l'abonnement ou du
  // paiement Checkout aura peut-être eu le temps d'arriver).
  if (!userId) throw new Error(`No Vynl account for invoice ${invoiceId}`);

  const extra = await fetchChargeAndFee(fields.provider_payment_id);
  const { error } = await supabaseAdmin.from("payments").insert({
    ...fields,
    user_id: userId,
    subscription_id: subscription?.id ?? null,
    plan: subscription?.plan ?? null,
    provider: "stripe",
    provider_charge_id: extra.chargeId,
    fee_cents: extra.fee,
  });
  if (error && error.code !== UNIQUE_VIOLATION) throw error;
  return "processed";
}

async function syncRefund(chargeId: string): Promise<Outcome> {
  const charge = await getStripe().charges.retrieve(chargeId);

  const { data: payment, error } = await supabaseAdmin
    .from("payments")
    .select("id, gross_cents, refunded_cents")
    .eq("provider", "stripe")
    .eq("provider_charge_id", charge.id)
    .maybeSingle();
  if (error) throw error;
  // La charge n'est pas (encore) rattachée à un paiement : on échoue, Stripe réessaiera.
  if (!payment) throw new Error(`No payment recorded for charge ${charge.id}`);

  const refunded = Math.min(charge.amount_refunded, payment.gross_cents);
  if (refunded <= payment.refunded_cents) return "processed"; // un remboursement ne diminue jamais

  const { error: updateError } = await supabaseAdmin
    .from("payments")
    .update({ refunded_cents: refunded, status: paymentStatus(payment.gross_cents, refunded) })
    .eq("id", payment.id);
  if (updateError) throw updateError;
  return "processed";
}

async function linkCheckoutCustomer(session: Stripe.Checkout.Session): Promise<Outcome> {
  if (session.mode !== "subscription") return "ignored";
  const customerId = idOf(session.customer);
  if (session.client_reference_id && customerId) {
    const { error } = await supabaseAdmin
      .from("billing_customers")
      .insert({ user_id: session.client_reference_id, provider_customer_id: customerId });
    if (error && error.code !== UNIQUE_VIOLATION) throw error;
  }
  const subscriptionId = idOf(session.subscription);
  if (subscriptionId) await syncSubscription(subscriptionId);
  return "processed";
}

// Traite un événement déjà VÉRIFIÉ (signature) par le webhook. Lève une erreur si le traitement
// échoue : le webhook répond alors 500 et Stripe réessaiera.
export async function processStripeEvent(event: Stripe.Event): Promise<Outcome> {
  switch (event.type) {
    case "checkout.session.completed":
      return linkCheckoutCustomer(event.data.object);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return syncSubscription(event.data.object.id);
    case "invoice.paid":
      return recordInvoicePaid(event.data.object.id as string);
    case "charge.refunded":
      return syncRefund(event.data.object.id);
    default:
      return "ignored";
  }
}
