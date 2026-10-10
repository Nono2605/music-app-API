import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEntitlement } from "./entitlement";

const now = new Date("2026-10-09T12:00:00Z");
const future = "2026-11-01T00:00:00Z";
const past = "2026-09-01T00:00:00Z";

describe("resolveEntitlement", () => {
  it("bêta : toute lecture vaut « beta », même avec un abonnement actif", () => {
    assert.equal(resolveEntitlement("beta", null, now), "beta");
    assert.equal(resolveEntitlement("beta", { status: "active", current_period_end: future }, now), "beta");
  });

  it("en ligne : abonnement actif dans sa période -> subscriber", () => {
    assert.equal(resolveEntitlement("live", { status: "active", current_period_end: future }, now), "subscriber");
  });

  it("en ligne : essai en cours -> trial", () => {
    assert.equal(resolveEntitlement("live", { status: "trialing", current_period_end: future }, now), "trial");
  });

  it("en ligne : aucun abonnement -> free_ad_supported", () => {
    assert.equal(resolveEntitlement("live", null, now), "free_ad_supported");
  });

  it("en ligne : période échue ou abonnement résilié -> free_ad_supported", () => {
    assert.equal(resolveEntitlement("live", { status: "active", current_period_end: past }, now), "free_ad_supported");
    for (const status of ["canceled", "expired", "past_due"]) {
      assert.equal(resolveEntitlement("live", { status, current_period_end: future }, now), "free_ad_supported", status);
    }
  });

  it("en ligne : une période sans date de fin est valable", () => {
    assert.equal(resolveEntitlement("live", { status: "active", current_period_end: null }, now), "subscriber");
  });
});
