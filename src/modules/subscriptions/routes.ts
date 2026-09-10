import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";

export const subscriptionsRouter = Router();

// GET /subscriptions/me — abonnement le plus récent de l'utilisateur, s'il existe.
// Lecture seule : le paiement réel (Stripe) n'est pas encore branché.
subscriptionsRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("subscriptions")
      .select("id, plan, status, current_period_start, current_period_end, cancel_at_period_end")
      .eq("user_id", req.auth!.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    res.json({ subscription: data ?? null });
  } catch (err) {
    next(err);
  }
});
