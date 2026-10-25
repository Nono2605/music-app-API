import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildConfigReport, type ConfigInput } from "./configReport";

const base: ConfigInput = {
  entitlementMode: "beta",
  authLocalVerify: false,
  stripeAllowLive: false,
  stripeAutomaticTax: false,
  corsAllowedOrigins: [],
};
const runtime = { nodeVersion: "v22.1.0", uptimeSeconds: 125.6 };

describe("buildConfigReport", () => {
  it("une configuration vide : aucun secret réglé, aucun mode Stripe", () => {
    const report = buildConfigReport(base, runtime);
    assert.deepEqual(report.secrets, {
      ip_hash_secret: false,
      webapp_shared_secret: false,
      stripe_secret_key: false,
      stripe_webhook_secret: false,
      cdn_token_secret: false,
    });
    assert.deepEqual(report.cdn, { active: false, host: null, configured_host: null });
    assert.equal(report.stripe.mode, null);
    assert.equal(report.checkout_return_host, null);
    assert.deepEqual(report.cors_allowed_origins, []);
  });

  it("ne contient JAMAIS la valeur d'un secret", () => {
    const secrets = {
      ipHashSecret: "ip-secret-VALUE-1234567890",
      webappSharedSecret: "webapp-secret-VALUE-1234567890",
      stripeSecretKey: "sk_test_VALUE1234567890",
      stripeWebhookSecret: "whsec_VALUE1234567890",
      cdnTokenSecret: "cdn-secret-VALUE-1234567890",
    };
    const text = JSON.stringify(buildConfigReport({ ...base, ...secrets, checkoutReturnBaseUrl: "https://app.vynl.ch/account?token=abc" }, runtime));
    for (const value of Object.values(secrets)) assert.equal(text.includes(value), false, value);
    assert.equal(text.includes("token=abc"), false);
    assert.equal(text.includes("VALUE"), false);
  });

  it("indique seulement que les secrets sont réglés", () => {
    const report = buildConfigReport(
      { ...base, ipHashSecret: "a", webappSharedSecret: "b", stripeSecretKey: "sk_test_x", stripeWebhookSecret: "whsec_x", cdnTokenSecret: "c" },
      runtime
    );
    assert.deepEqual(report.secrets, { ip_hash_secret: true, webapp_shared_secret: true, stripe_secret_key: true, stripe_webhook_secret: true, cdn_token_secret: true });
  });

  it("reconnaît le mode Stripe d'après la clé, sans la rendre", () => {
    assert.equal(buildConfigReport({ ...base, stripeSecretKey: "sk_test_abc" }, runtime).stripe.mode, "test");
    assert.equal(buildConfigReport({ ...base, stripeSecretKey: "sk_live_abc" }, runtime).stripe.mode, "live");
    assert.equal(buildConfigReport({ ...base, stripeSecretKey: "rk_live_abc" }, runtime).stripe.mode, "live");
    assert.equal(buildConfigReport({ ...base, stripeSecretKey: "n'importe quoi" }, runtime).stripe.mode, null);
  });

  it("une adresse n'apparaît que par son nom d'hôte", () => {
    assert.equal(buildConfigReport({ ...base, checkoutReturnBaseUrl: "https://app.vynl.ch" }, runtime).checkout_return_host, "app.vynl.ch");
    assert.equal(buildConfigReport({ ...base, checkoutReturnBaseUrl: "pas une adresse" }, runtime).checkout_return_host, null);
  });

  it("raccourcit le commit à 7 caractères et arrondit la durée", () => {
    const report = buildConfigReport(base, { ...runtime, commit: "3e662c9abcdef0123456789" });
    assert.equal(report.deploy.commit, "3e662c9");
    assert.equal(report.deploy.uptime_seconds, 126);
    assert.equal(buildConfigReport(base, runtime).deploy.commit, null);
  });

  it("reprend les modes et les origines CORS tels quels", () => {
    const report = buildConfigReport(
      { ...base, entitlementMode: "live", authLocalVerify: true, stripeAutomaticTax: true, corsAllowedOrigins: ["https://app.vynl.ch"] },
      runtime
    );
    assert.equal(report.entitlement_mode, "live");
    assert.equal(report.auth_local_verify, true);
    assert.equal(report.stripe.automatic_tax, true);
    assert.deepEqual(report.cors_allowed_origins, ["https://app.vynl.ch"]);
  });

  it("CDN : actif seulement avec une adresse valide ET le secret ; sinon on voit ce qui manque", () => {
    const active = buildConfigReport({ ...base, cdnBaseUrl: "https://cdn.vynl.li/", cdnTokenSecret: "s", cdn: { baseUrl: "https://cdn.vynl.li" } }, runtime);
    assert.deepEqual(active.cdn, { active: true, host: "cdn.vynl.li", configured_host: "cdn.vynl.li" });

    // Adresse demandée mais secret absent : l'API ne l'utilise pas (cdn indéfini), le rapport le dit.
    const noSecret = buildConfigReport({ ...base, cdnBaseUrl: "https://cdn.vynl.li" }, runtime);
    assert.deepEqual(noSecret.cdn, { active: false, host: null, configured_host: "cdn.vynl.li" });
    assert.equal(noSecret.secrets.cdn_token_secret, false);

    // Adresse en http : refusée par l'API, donc inactive, mais l'adresse demandée reste visible.
    const badUrl = buildConfigReport({ ...base, cdnBaseUrl: "http://cdn.vynl.li", cdnTokenSecret: "s" }, runtime);
    assert.deepEqual(badUrl.cdn, { active: false, host: null, configured_host: "cdn.vynl.li" });
  });
});
