import { Router, type Response } from "express";
import {
  BillingConflictError,
  BillingPlanError,
  BillingUnavailableError,
  createCheckout,
  createPortal,
  listActivePlans,
} from "../../lib/billing";
import { StripeNotConfiguredError } from "../../lib/stripe";
import { requireAuth, requireAuthStrict } from "../../middleware/auth";
import { requireSubscriptionsOpen } from "../../middleware/subscriptionsOpen";

export const billingRouter = Router();

const NOT_MIGRATED_CODES = new Set(["42P01", "PGRST205"]);

// Une erreur de facturation → la bonne réponse, sans jamais renvoyer un message de Stripe (il
// peut citer des éléments de la clé ou du compte).
function failure(res: Response, err: unknown) {
  if (err instanceof BillingPlanError) return res.status(400).json({ error: err.message });
  if (err instanceof BillingConflictError) return res.status(409).json({ error: err.message });
  if (err instanceof BillingUnavailableError || err instanceof StripeNotConfiguredError) {
    // La raison reste dans les journaux (ces messages ne contiennent jamais de clé) : le client,
    // lui, ne voit qu'« indisponible ».
    console.warn(`Billing unavailable: ${err.message}`);
    return res.status(503).json({ error: "Payments are not available yet", code: "billing_unavailable" });
  }
  const code = (err as { code?: string } | null)?.code;
  if (code && NOT_MIGRATED_CODES.has(code)) {
    console.warn(`Billing unavailable: the billing tables are missing (${code})`);
    return res.status(503).json({ error: "Payments are not available yet", code: "billing_unavailable" });
  }
  const { type } = (err ?? {}) as { type?: string };
  if (type?.startsWith("Stripe")) {
    console.error(`Stripe error: ${type}`);
    return res.status(502).json({ error: "The payment provider refused the request", code: "billing_provider_error" });
  }
  return null;
}

// GET /billing/plans — les offres actives : prix et devise à AFFICHER. « purchasable » dit si
// le plan est relié à Stripe (sinon le bouton d'achat n'a pas de sens). Jamais d'identifiant Stripe.
billingRouter.get("/plans", requireAuth, async (_req, res, next) => {
  try {
    const plans = await listActivePlans();
    res.json({
      plans: plans.map((plan) => ({
        code: plan.code,
        name: plan.name,
        price_cents: plan.price_cents,
        currency: plan.currency,
        interval: plan.interval,
        tax_behavior: plan.tax_behavior,
        ad_supported: plan.ad_supported,
        purchasable: plan.price_cents > 0 && plan.stripe_price_id !== null,
      })),
    });
  } catch (err) {
    failure(res, err) ?? next(err);
  }
});

// POST /billing/checkout { plan } — l'adresse de la page de paiement Stripe pour ce plan.
billingRouter.post("/checkout", requireSubscriptionsOpen, requireAuthStrict, async (req, res, next) => {
  try {
    const plan = req.body?.plan;
    if (typeof plan !== "string" || !/^[a-z][a-z0-9_]{1,30}$/.test(plan)) {
      return res.status(400).json({ error: "plan is required" });
    }
    res.json({ url: await createCheckout(req.auth!.id, plan) });
  } catch (err) {
    failure(res, err) ?? next(err);
  }
});

// POST /billing/portal — l'adresse du portail client Stripe (carte, factures, résiliation).
billingRouter.post("/portal", requireSubscriptionsOpen, requireAuthStrict, async (req, res, next) => {
  try {
    res.json({ url: await createPortal(req.auth!.id) });
  } catch (err) {
    failure(res, err) ?? next(err);
  }
});
