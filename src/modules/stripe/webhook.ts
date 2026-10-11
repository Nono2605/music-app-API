import type { Request, Response } from "express";
import { env } from "../../config/env";
import { processStripeEvent } from "../../lib/billing";
import { getStripe, stripeProblem } from "../../lib/stripe";
import { supabaseAdmin } from "../../lib/supabaseAdmin";

// POST /stripe/webhook — Stripe nous prévient (abonnement créé ou changé, facture payée,
// remboursement). Monté dans app.ts AVANT le lecteur JSON : la signature se vérifie sur le
// corps BRUT, tel que Stripe l'a envoyé.
//
// Règles :
//  * pas de secret de webhook configuré, ou signature invalide : on refuse, sans rien lire ;
//  * chaque événement n'est traité qu'une fois (table stripe_events, clé = identifiant Stripe) ;
//  * si le traitement échoue, on répond 500 : Stripe réessaie pendant plusieurs jours, et
//    l'erreur reste dans stripe_events pour le diagnostic ;
//  * un événement « live » est ignoré tant que STRIPE_ALLOW_LIVE n'est pas « yes ».
const UNIQUE_VIOLATION = "23505";

export async function stripeWebhook(req: Request, res: Response) {
  const secret = env.stripeWebhookSecret;
  if (!secret || stripeProblem()) {
    return res.status(503).json({ error: "The Stripe webhook is not configured", code: "webhook_unavailable" });
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: "Missing signature or body" });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, signature, secret);
  } catch {
    return res.status(400).json({ error: "Invalid signature" });
  }

  try {
    const { data: known, error: lookupError } = await supabaseAdmin
      .from("stripe_events")
      .select("outcome")
      .eq("id", event.id)
      .maybeSingle();
    if (lookupError) throw lookupError;

    // Déjà traité : on confirme sans refaire.
    if (known && (known.outcome === "processed" || known.outcome === "ignored")) {
      return res.json({ received: true, duplicate: true });
    }

    if (!known) {
      const { error: insertError } = await supabaseAdmin.from("stripe_events").insert({
        id: event.id,
        type: event.type,
        livemode: event.livemode,
        provider_created_at: new Date(event.created * 1000).toISOString(),
      });
      if (insertError && insertError.code !== UNIQUE_VIOLATION) throw insertError;
    }

    const finish = async (outcome: "processed" | "ignored" | "failed", error?: string) => {
      const { error: updateError } = await supabaseAdmin
        .from("stripe_events")
        .update({ outcome, processed_at: new Date().toISOString(), error: error ?? null })
        .eq("id", event.id);
      if (updateError) console.error(`Could not record the outcome of Stripe event ${event.id}: ${updateError.message}`);
    };

    if (event.livemode && !env.stripeAllowLive) {
      await finish("ignored", "live event on a development API");
      return res.json({ received: true, ignored: true });
    }

    try {
      const outcome = await processStripeEvent(event);
      await finish(outcome);
      return res.json({ received: true });
    } catch (err) {
      const message = (err instanceof Error ? err.message : "Unknown error").slice(0, 500);
      console.error(`Stripe event ${event.id} (${event.type}) failed: ${message}`);
      await finish("failed", message);
      return res.status(500).json({ error: "Processing failed, will be retried" });
    }
  } catch (err) {
    // La base elle-même est injoignable : 500 aussi, Stripe réessaiera.
    console.error("Stripe webhook: database error", err);
    return res.status(500).json({ error: "Temporarily unavailable" });
  }
}
