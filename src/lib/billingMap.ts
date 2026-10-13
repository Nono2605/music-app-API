import type Stripe from "stripe";

// Conversions PURES (aucune base, aucun appel Stripe) entre les objets Stripe et nos lignes.
// Les objets reçus ici ont été RELUS auprès de Stripe avec le SDK épinglé (voir lib/billing.ts),
// jamais lus tels quels dans un événement : la version d'API réglée dans le tableau de bord
// ne peut donc pas changer leur forme, et l'ordre d'arrivée des événements n'a pas d'effet.

export type OurSubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";

// Les statuts de Stripe vers les nôtres. null = on n'écrit rien : « incomplete » est un premier
// paiement pas encore réussi, ce n'est pas (encore) un abonnement.
export function mapSubscriptionStatus(status: string): OurSubscriptionStatus | null {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    // Un paiement a échoué ou l'abonnement est suspendu : plus d'accès payant (voir
    // lib/entitlement.ts, seul « active » et « trialing » donnent un droit).
    case "past_due":
    case "unpaid":
    case "paused":
      return "past_due";
    case "canceled":
      return "canceled";
    case "incomplete_expired":
      return "expired";
    default:
      return null;
  }
}

export function toIso(unixSeconds: number | null | undefined): string | null {
  return typeof unixSeconds === "number" ? new Date(unixSeconds * 1000).toISOString() : null;
}

type SubscriptionWithItems = Pick<Stripe.Subscription, "items">;

// La période courante d'un abonnement est portée par ses lignes (un abonnement Vynl n'en a
// qu'une) : début le plus ancien, fin la plus lointaine.
export function subscriptionPeriod(sub: SubscriptionWithItems): { start: string | null; end: string | null } {
  const items = sub.items?.data ?? [];
  if (items.length === 0) return { start: null, end: null };
  const start = Math.min(...items.map((item) => item.current_period_start));
  const end = Math.max(...items.map((item) => item.current_period_end));
  return { start: toIso(start), end: toIso(end) };
}

export function subscriptionPriceId(sub: SubscriptionWithItems): string | null {
  return sub.items?.data?.[0]?.price?.id ?? null;
}

// Un champ Stripe « identifiant ou objet développé » → l'identifiant.
export function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return idOf(invoice.parent?.subscription_details?.subscription ?? null);
}

export interface PaymentFields {
  provider_payment_id: string;
  currency: string;
  gross_cents: number;
  tax_cents: number;
  service_period_start: string | null;
  service_period_end: string | null;
  paid_at: string;
}

// Une facture payée → un paiement. Pas de paiement pour une facture à 0 (essai, avoir) : rien n'a
// été encaissé. Le brut est ce que le client a payé, TAXE COMPRISE ; la taxe est la somme des
// taxes de la facture (comprises dans un prix TTC, ajoutées dans un prix HT : dans les deux cas
// elles font partie de ce que le client a payé).
export function invoiceToPayment(invoice: Stripe.Invoice): PaymentFields | null {
  if (!invoice.amount_paid || invoice.amount_paid <= 0) return null;

  const tax = (invoice.total_taxes ?? []).reduce((total, entry) => total + entry.amount, 0);
  const line = invoice.lines?.data?.[0];
  const paidAt = invoice.status_transitions?.paid_at ?? invoice.created;

  return {
    provider_payment_id: invoice.id as string,
    currency: invoice.currency.toLowerCase(),
    gross_cents: invoice.amount_paid,
    tax_cents: tax,
    service_period_start: toIso(line?.period?.start ?? invoice.period_start),
    service_period_end: toIso(line?.period?.end ?? invoice.period_end),
    paid_at: new Date(paidAt * 1000).toISOString(),
  };
}

export function paymentStatus(gross: number, refunded: number): "paid" | "partially_refunded" | "refunded" {
  if (refunded <= 0) return "paid";
  return refunded >= gross ? "refunded" : "partially_refunded";
}

// Adresses de retour de Stripe Checkout : l'app auditeur, page Réglages. La base vient de
// CHECKOUT_RETURN_BASE_URL ; null si elle est absente ou n'est pas une adresse http(s).
export function checkoutUrls(base: string | undefined): { success: string; cancel: string; account: string } | null {
  const value = base?.trim().replace(/\/+$/, "");
  if (!value || !/^https?:\/\/[^\s/]+/.test(value)) return null;
  return {
    success: `${value}/account?checkout=success`,
    cancel: `${value}/account?checkout=cancelled`,
    // Retour du portail client : la page Réglages, sans message.
    account: `${value}/account`,
  };
}

// --- Propriétaire d'un abonnement ou d'un paiement, quand le compte a pu être supprimé ---------------
//
// Quand un compte est supprimé, Vynl annule son abonnement chez Stripe ; Stripe envoie ensuite des
// événements (customer.subscription.deleted…) pour un abonnement dont le compte n'existe plus : la ligne
// `subscriptions` existe encore (son user_id est passé à null), mais `billing_customers` a disparu et la
// métadonnée de l'abonnement cite un compte inexistant. Ces deux fonctions décident quoi faire sans jamais
// réécrire un user_id vers un compte supprimé (clé étrangère), ni échouer en boucle.

export type SubscriptionOwner = { action: "keep" } | { action: "set"; userId: string } | { action: "none" };

// Ligne `subscriptions` déjà là : on ne touche pas à son propriétaire (null = compte supprimé : il le reste).
// Pas de ligne : le propriétaire indiqué par Stripe, s'il y en a un.
export function subscriptionOwner(
  existing: { user_id: string | null } | null,
  claimedUserId: string | null | undefined
): SubscriptionOwner {
  if (existing) return { action: "keep" };
  return claimedUserId ? { action: "set", userId: claimedUserId } : { action: "none" };
}

// Le compte d'un paiement. Un abonnement connu sans compte (supprimé) donne un paiement sans compte (null),
// qui reste une pièce comptable ; ni abonnement ni compte : on ne sait pas à qui l'attribuer.
export function paymentOwner(
  subscription: { user_id: string | null } | null,
  customerUserId: string | null
): { known: true; userId: string | null } | { known: false } {
  const userId = subscription?.user_id ?? customerUserId;
  if (userId) return { known: true, userId };
  return subscription ? { known: true, userId: null } : { known: false };
}
