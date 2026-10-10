import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStatusCache, isBlockedStatus } from "./accountStatus";

describe("isBlockedStatus", () => {
  it("un compte actif passe", () => {
    assert.equal(isBlockedStatus("active"), false);
  });

  it("un compte suspendu ou supprimé est bloqué", () => {
    assert.equal(isBlockedStatus("suspended"), true);
    assert.equal(isBlockedStatus("deleted"), true);
  });

  it("une ligne introuvable n'est pas bloquée", () => {
    assert.equal(isBlockedStatus(null), false);
  });
});

describe("createStatusCache", () => {
  it("ne relit pas la base tant que la durée de vie n'est pas écoulée", async () => {
    let clock = 0;
    let reads = 0;
    const status = createStatusCache(async () => (reads++, "active"), 1000, () => clock);

    assert.equal(await status("u1"), "active");
    clock = 999;
    assert.equal(await status("u1"), "active");
    assert.equal(reads, 1);
  });

  it("relit après expiration : une suspension finit par être vue", async () => {
    let clock = 0;
    let current = "active";
    const status = createStatusCache(async () => current, 1000, () => clock);

    assert.equal(await status("u1"), "active");
    current = "suspended";
    clock = 999;
    assert.equal(await status("u1"), "active"); // encore en cache
    clock = 1000;
    assert.equal(await status("u1"), "suspended");
  });

  it("garde un cache par utilisateur", async () => {
    const statuses: Record<string, string> = { u1: "active", u2: "suspended" };
    const status = createStatusCache(async (id) => statuses[id] ?? null, 1000, () => 0);

    assert.equal(await status("u1"), "active");
    assert.equal(await status("u2"), "suspended");
    assert.equal(await status("u3"), null);
  });

  it("n'enregistre pas une erreur de lecture", async () => {
    let fail = true;
    const status = createStatusCache(async () => {
      if (fail) throw new Error("db down");
      return "active";
    }, 1000, () => 0);

    await assert.rejects(() => status("u1"), /db down/);
    fail = false;
    assert.equal(await status("u1"), "active");
  });
});
