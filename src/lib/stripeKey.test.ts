import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripeKeyMode, stripeKeyProblem } from "./stripeKey";

// Des clés FACTICES, de la bonne forme : jamais une vraie clé dans un test.
const TEST_KEY = "sk_test_" + "a1B2c3D4e5F6g7H8i9J0";
const LIVE_KEY = "sk_live_" + "a1B2c3D4e5F6g7H8i9J0";
const RESTRICTED_TEST = "rk_test_" + "a1B2c3D4e5F6g7H8i9J0";

describe("stripeKeyMode", () => {
  it("reconnaît une clé secrète ou restreinte, de test ou live", () => {
    assert.equal(stripeKeyMode(TEST_KEY), "test");
    assert.equal(stripeKeyMode(RESTRICTED_TEST), "test");
    assert.equal(stripeKeyMode(LIVE_KEY), "live");
  });

  it("ne reconnaît ni la clé publiable, ni un secret de webhook, ni du bruit", () => {
    for (const bad of ["pk_test_" + "a1B2c3D4e5F6g7H8i9J0", "whsec_" + "a1B2c3D4e5F6g7H8i9J0", "sk_test_short", "sk_prod_" + "a1B2c3D4e5F6g7H8i9J0", "", undefined]) {
      assert.equal(stripeKeyMode(bad), null, String(bad));
    }
  });
});

describe("stripeKeyProblem", () => {
  it("une clé de test est utilisable", () => {
    assert.equal(stripeKeyProblem(TEST_KEY, false), null);
    assert.equal(stripeKeyProblem(RESTRICTED_TEST, false), null);
  });

  it("une clé live est refusée en développement, acceptée si on le dit explicitement", () => {
    assert.match(stripeKeyProblem(LIVE_KEY, false) ?? "", /LIVE/);
    assert.equal(stripeKeyProblem(LIVE_KEY, true), null);
  });

  it("clé absente : le dit", () => {
    assert.match(stripeKeyProblem(undefined, false) ?? "", /not set/);
    assert.match(stripeKeyProblem("", false) ?? "", /not set/);
  });

  it("la clé publiable collée à la place de la clé secrète : message précis", () => {
    assert.match(stripeKeyProblem("pk_test_" + "a1B2c3D4e5F6g7H8i9J0", false) ?? "", /publishable/);
  });

  it("n'importe quoi d'autre : pas une clé secrète", () => {
    assert.match(stripeKeyProblem("hello world", false) ?? "", /not a Stripe secret key/);
  });

  it("aucun message ne reprend la clé reçue", () => {
    for (const key of [TEST_KEY, LIVE_KEY, "pk_test_" + "a1B2c3D4e5F6g7H8i9J0", "garbage-" + "a1B2c3D4e5F6g7H8i9J0"]) {
      const problem = stripeKeyProblem(key, false);
      if (problem) assert.ok(!problem.includes("a1B2c3D4e5F6g7H8i9J0"), problem);
    }
  });
});
