import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import {
  checkoutUrls,
  idOf,
  invoiceSubscriptionId,
  invoiceToPayment,
  mapSubscriptionStatus,
  paymentOwner,
  paymentStatus,
  subscriptionOwner,
  subscriptionPeriod,
  subscriptionPriceId,
  toIso,
} from "./billingMap";

// Des objets Stripe réduits à ce que lisent les fonctions, qui ressemblent à la réponse de l'API.
const asInvoice = (value: unknown) => value as Stripe.Invoice;
const asSub = (value: unknown) => value as Stripe.Subscription;

describe("mapSubscriptionStatus", () => {
  it("les statuts qui donnent ou retirent l'accès", () => {
    assert.equal(mapSubscriptionStatus("active"), "active");
    assert.equal(mapSubscriptionStatus("trialing"), "trialing");
    assert.equal(mapSubscriptionStatus("canceled"), "canceled");
    assert.equal(mapSubscriptionStatus("incomplete_expired"), "expired");
  });

  it("un paiement en échec, impayé ou suspendu : « past_due » (aucun accès payant)", () => {
    for (const status of ["past_due", "unpaid", "paused"]) assert.equal(mapSubscriptionStatus(status), "past_due", status);
  });

  it("« incomplete » et tout statut inconnu : rien à écrire", () => {
    assert.equal(mapSubscriptionStatus("incomplete"), null);
    assert.equal(mapSubscriptionStatus("something_new"), null);
  });
});

describe("subscriptionPeriod / subscriptionPriceId", () => {
  const sub = asSub({
    items: { data: [{ current_period_start: 1_760_000_000, current_period_end: 1_762_592_000, price: { id: "price_1" } }] },
  });

  it("période et prix lus sur la ligne de l'abonnement", () => {
    assert.deepEqual(subscriptionPeriod(sub), { start: toIso(1_760_000_000), end: toIso(1_762_592_000) });
    assert.equal(subscriptionPriceId(sub), "price_1");
  });

  it("plusieurs lignes : le début le plus ancien, la fin la plus lointaine", () => {
    const two = asSub({
      items: {
        data: [
          { current_period_start: 200, current_period_end: 300, price: { id: "a" } },
          { current_period_start: 100, current_period_end: 400, price: { id: "b" } },
        ],
      },
    });
    assert.deepEqual(subscriptionPeriod(two), { start: toIso(100), end: toIso(400) });
  });

  it("aucune ligne : pas de période, pas de prix", () => {
    assert.deepEqual(subscriptionPeriod(asSub({ items: { data: [] } })), { start: null, end: null });
    assert.equal(subscriptionPriceId(asSub({ items: { data: [] } })), null);
  });
});

describe("invoiceToPayment — 10.00 CHF TTC, TVA suisse 8,1 % comprise", () => {
  const invoice = asInvoice({
    id: "in_1",
    currency: "CHF",
    amount_paid: 1000,
    total_taxes: [{ amount: 75, tax_behavior: "inclusive" }],
    lines: { data: [{ period: { start: 1_760_000_000, end: 1_762_592_000 } }] },
    period_start: 1,
    period_end: 2,
    status_transitions: { paid_at: 1_760_000_100 },
    created: 1_759_999_000,
  });

  it("brut payé, taxe, période de service, date de paiement ; devise en minuscules", () => {
    assert.deepEqual(invoiceToPayment(invoice), {
      provider_payment_id: "in_1",
      currency: "chf",
      gross_cents: 1000,
      tax_cents: 75,
      service_period_start: toIso(1_760_000_000),
      service_period_end: toIso(1_762_592_000),
      paid_at: toIso(1_760_000_100),
    });
  });

  it("plusieurs taxes : elles s'additionnent", () => {
    const multi = asInvoice({ ...invoice, total_taxes: [{ amount: 50 }, { amount: 25 }] });
    assert.equal(invoiceToPayment(multi)?.tax_cents, 75);
  });

  it("aucune taxe (compte sans Stripe Tax) : 0", () => {
    assert.equal(invoiceToPayment(asInvoice({ ...invoice, total_taxes: null }))?.tax_cents, 0);
    assert.equal(invoiceToPayment(asInvoice({ ...invoice, total_taxes: [] }))?.tax_cents, 0);
  });

  it("facture à 0 (essai, avoir) : rien n'a été encaissé, pas de paiement", () => {
    assert.equal(invoiceToPayment(asInvoice({ ...invoice, amount_paid: 0 })), null);
    assert.equal(invoiceToPayment(asInvoice({ ...invoice, amount_paid: undefined })), null);
  });

  it("sans date de paiement : la date de création de la facture", () => {
    const noPaidAt = asInvoice({ ...invoice, status_transitions: {} });
    assert.equal(invoiceToPayment(noPaidAt)?.paid_at, toIso(1_759_999_000));
  });

  it("sans ligne : la période de la facture", () => {
    const noLines = asInvoice({ ...invoice, lines: { data: [] } });
    assert.equal(invoiceToPayment(noLines)?.service_period_start, toIso(1));
  });
});

describe("invoiceSubscriptionId / idOf", () => {
  it("l'abonnement d'une facture : identifiant ou objet développé", () => {
    assert.equal(invoiceSubscriptionId(asInvoice({ parent: { subscription_details: { subscription: "sub_1" } } })), "sub_1");
    assert.equal(invoiceSubscriptionId(asInvoice({ parent: { subscription_details: { subscription: { id: "sub_2" } } } })), "sub_2");
  });

  it("facture sans abonnement : null", () => {
    assert.equal(invoiceSubscriptionId(asInvoice({ parent: null })), null);
    assert.equal(invoiceSubscriptionId(asInvoice({})), null);
  });

  it("idOf", () => {
    assert.equal(idOf("cus_1"), "cus_1");
    assert.equal(idOf({ id: "cus_2" }), "cus_2");
    assert.equal(idOf(null), null);
  });
});

describe("paymentStatus", () => {
  it("payé, remboursé en partie, remboursé", () => {
    assert.equal(paymentStatus(1000, 0), "paid");
    assert.equal(paymentStatus(1000, 400), "partially_refunded");
    assert.equal(paymentStatus(1000, 1000), "refunded");
    assert.equal(paymentStatus(1000, 1200), "refunded");
  });
});

describe("checkoutUrls", () => {
  it("construit les deux adresses de retour, sans double barre", () => {
    assert.deepEqual(checkoutUrls("https://app.vynl.com/"), {
      success: "https://app.vynl.com/account?checkout=success",
      cancel: "https://app.vynl.com/account?checkout=cancelled",
      account: "https://app.vynl.com/account",
    });
  });

  it("absente ou invalide : null (le paiement n'est pas disponible)", () => {
    for (const bad of [undefined, "", "   ", "app.vynl.com", "javascript:alert(1)", "ftp://x"]) {
      assert.equal(checkoutUrls(bad), null, String(bad));
    }
  });
});

describe("subscriptionOwner (compte peut-être supprimé)", () => {
  it("une ligne existe déjà : on ne touche pas à son propriétaire, même s'il est null (compte supprimé)", () => {
    assert.deepEqual(subscriptionOwner({ user_id: "u1" }, "u1"), { action: "keep" });
    assert.deepEqual(subscriptionOwner({ user_id: null }, "ancien-compte"), { action: "keep" });
  });
  it("pas de ligne : le propriétaire annoncé par Stripe", () => {
    assert.deepEqual(subscriptionOwner(null, "u1"), { action: "set", userId: "u1" });
  });
  it("ni ligne ni propriétaire : aucun", () => {
    assert.deepEqual(subscriptionOwner(null, null), { action: "none" });
    assert.deepEqual(subscriptionOwner(null, undefined), { action: "none" });
    assert.deepEqual(subscriptionOwner(null, ""), { action: "none" });
  });
});

describe("paymentOwner (compte peut-être supprimé)", () => {
  it("l'abonnement connaît son compte", () => {
    assert.deepEqual(paymentOwner({ user_id: "u1" }, null), { known: true, userId: "u1" });
  });
  it("sinon, le compte du client Stripe", () => {
    assert.deepEqual(paymentOwner(null, "u2"), { known: true, userId: "u2" });
    assert.deepEqual(paymentOwner({ user_id: null }, "u2"), { known: true, userId: "u2" });
  });
  it("abonnement connu dont le compte a été supprimé : paiement conservé, sans compte", () => {
    assert.deepEqual(paymentOwner({ user_id: null }, null), { known: true, userId: null });
  });
  it("ni abonnement ni compte : inconnu (Stripe réessaiera)", () => {
    assert.deepEqual(paymentOwner(null, null), { known: false });
  });
});
