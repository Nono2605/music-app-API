import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

// `node --test` lance chaque fichier dans son propre processus : on peut régler l'environnement
// AVANT le premier import du code (la configuration est lue une seule fois). Clés FACTICES ; la
// base pointe vers un port fermé, donc rien ne sort et l'échec est immédiat.
const SECRET = "whsec_" + "testsecrettestsecrettestsecret12";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SECRET_KEY = "sb_secret_" + "fake0000000000000000";
process.env.STRIPE_SECRET_KEY = "sk_test_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

let stripeWebhook: (req: Request, res: Response) => Promise<unknown>;
let sign: (payload: string, timestamp?: number) => string;

before(async () => {
  ({ stripeWebhook } = await import("./webhook.js"));
  const { getStripe } = await import("../../lib/stripe.js");
  sign = (payload, timestamp) =>
    getStripe().webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp });
});

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

const payload = JSON.stringify({ id: "evt_test_1", object: "event", type: "customer.subscription.updated", livemode: false, created: 1760000000, data: { object: { id: "sub_1" } } });
const request = (body: unknown, signature?: string) =>
  ({ headers: signature === undefined ? {} : { "stripe-signature": signature }, body }) as unknown as Request;

describe("webhook Stripe : la frontière de sécurité", () => {
  it("sans en-tête de signature : refusé (400)", async () => {
    const res = fakeRes();
    await stripeWebhook(request(Buffer.from(payload)), res as unknown as Response);
    assert.equal(res.statusCode, 400);
  });

  it("corps déjà analysé (pas le corps brut) : refusé (400), jamais accepté « au hasard »", async () => {
    const res = fakeRes();
    await stripeWebhook(request(JSON.parse(payload), sign(payload)), res as unknown as Response);
    assert.equal(res.statusCode, 400);
  });

  it("fausse signature : refusée (400)", async () => {
    const res = fakeRes();
    await stripeWebhook(request(Buffer.from(payload), "t=1760000000,v1=deadbeef"), res as unknown as Response);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: "Invalid signature" });
  });

  it("signature faite avec un AUTRE secret : refusée (400)", async () => {
    const { getStripe } = await import("../../lib/stripe.js");
    const forged = getStripe().webhooks.generateTestHeaderString({ payload, secret: "whsec_" + "someoneelsessecretsomeoneelses12" });
    const res = fakeRes();
    await stripeWebhook(request(Buffer.from(payload), forged), res as unknown as Response);
    assert.equal(res.statusCode, 400);
  });

  it("corps modifié après signature : refusé (400)", async () => {
    const res = fakeRes();
    await stripeWebhook(request(Buffer.from(payload.replace("sub_1", "sub_EVIL")), sign(payload)), res as unknown as Response);
    assert.equal(res.statusCode, 400);
  });

  it("signature trop ancienne (rejeu) : refusée (400)", async () => {
    const res = fakeRes();
    const old = Math.floor(Date.now() / 1000) - 3600;
    await stripeWebhook(request(Buffer.from(payload), sign(payload, old)), res as unknown as Response);
    assert.equal(res.statusCode, 400);
  });

  it("signature valide : on passe la vérification (ici la base est volontairement injoignable : 500, pas 400)", async () => {
    const res = fakeRes();
    await stripeWebhook(request(Buffer.from(payload), sign(payload)), res as unknown as Response);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "Temporarily unavailable" });
  });
});
