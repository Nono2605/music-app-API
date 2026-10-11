import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

// Sans secret de webhook, l'API refuse TOUTE livraison : jamais d'événement non vérifié.
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SECRET_KEY = "sb_secret_" + "fake0000000000000000";
process.env.STRIPE_SECRET_KEY = "sk_test_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
delete process.env.STRIPE_WEBHOOK_SECRET;

describe("webhook Stripe sans secret", () => {
  it("répond 503 et ne lit rien", async () => {
    const { stripeWebhook } = await import("./webhook.js");
    const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await stripeWebhook({ headers: { "stripe-signature": "t=1,v1=x" }, body: Buffer.from("{}") } as unknown as Request, res as unknown as Response);
    assert.equal(res.statusCode, 503);
  });
});

describe("webhook Stripe avec une clé live en développement", () => {
  it("la clé live est refusée avant toute chose : 503", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_" + "testsecrettestsecrettestsecret12";
    // La configuration est déjà lue dans ce processus : on teste donc la règle seule.
    const { stripeKeyProblem } = await import("../../lib/stripeKey.js");
    assert.match(stripeKeyProblem(process.env.STRIPE_SECRET_KEY, false) ?? "", /LIVE/);
  });
});
