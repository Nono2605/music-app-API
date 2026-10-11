import { Router } from "express";
import { getStripe, stripeMode, stripeProblem } from "../../lib/stripe";
import { requireAdmin } from "../../middleware/requireAdmin";
import { requireAuth } from "../../middleware/auth";

export const stripeRouter = Router();

// GET /stripe/status — l'API est-elle bien branchée sur le compte Stripe ? RÉSERVÉ AUX ADMINS.
// Ne renvoie jamais la clé : seulement si elle est utilisable, son mode (test / live) et l'identité
// publique du compte (identifiant, pays, devise). Sert à la page « Revenue » de l'admin.
stripeRouter.get("/status", requireAuth, requireAdmin, async (_req, res) => {
  const problem = stripeProblem();
  if (problem) return res.json({ configured: false, problem });

  const mode = stripeMode();
  try {
    const account = await getStripe().accounts.retrieveCurrent();
    res.json({
      configured: true,
      mode,
      ok: true,
      account: {
        id: account.id,
        country: account.country ?? null,
        default_currency: account.default_currency ?? null,
        charges_enabled: account.charges_enabled ?? false,
        payouts_enabled: account.payouts_enabled ?? false,
        details_submitted: account.details_submitted ?? false,
        business_name: account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? null,
      },
    });
  } catch (err) {
    // Le message d'une erreur Stripe peut citer une partie de la clé : on ne renvoie que son
    // type et son code, et on journalise de même.
    const { type, code } = err as { type?: string; code?: string };
    console.error(`Stripe status check failed: ${type ?? "unknown"} ${code ?? ""}`.trim());
    res.json({ configured: true, mode, ok: false, error: type ?? "unknown_error", code: code ?? null });
  }
});
