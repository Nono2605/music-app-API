import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDeletionRequest, performDeletion, type DeletionSteps } from "./accountDeletion";
import { recordPrivacyRequest, type PrivacyRequestDb } from "./privacyRequests";

const listener = { email: "Me@Example.com", role: "listener" };

describe("checkDeletionRequest", () => {
  it("accepte l'adresse e-mail saisie, sans tenir compte de la casse ni des espaces", () => {
    assert.deepEqual(checkDeletionRequest(listener, { confirm_email: "me@example.com" }), { ok: true });
    assert.deepEqual(checkDeletionRequest(listener, { confirm_email: "  ME@EXAMPLE.COM " }), { ok: true });
  });

  it("refuse une adresse différente, vide ou absente", () => {
    for (const body of [{ confirm_email: "autre@example.com" }, { confirm_email: "" }, {}, null, undefined, { confirm_email: 12 }]) {
      const result = checkDeletionRequest(listener, body);
      assert.equal(result.ok, false, JSON.stringify(body));
      if (!result.ok) {
        assert.equal(result.status, 400);
        assert.equal(result.code, "confirmation_mismatch");
      }
    }
  });

  it("refuse un compte sans adresse connue, même avec une saisie vide", () => {
    assert.equal(checkDeletionRequest({ email: null, role: "listener" }, { confirm_email: "" }).ok, false);
  });

  it("un compte administrateur ne se supprime pas ici, même avec la bonne adresse", () => {
    const result = checkDeletionRequest({ email: "a@b.c", role: "admin" }, { confirm_email: "a@b.c" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 403);
  });

  it("créateurs et auditeurs : autorisés", () => {
    assert.equal(checkDeletionRequest({ email: "a@b.c", role: "creator" }, { confirm_email: "a@b.c" }).ok, true);
  });
});

describe("performDeletion : l'ordre des opérations", () => {
  it("annule les abonnements AVANT de supprimer, et rend leur nombre", async () => {
    const calls: string[] = [];
    const steps: DeletionSteps = {
      cancelSubscriptions: async () => (calls.push("cancel"), 2),
      deleteAuthUser: async () => void calls.push("delete"),
    };
    assert.deepEqual(await performDeletion("u", steps), { subscriptionsCancelled: 2 });
    assert.deepEqual(calls, ["cancel", "delete"]);
  });

  it("si l'annulation échoue, RIEN n'est supprimé", async () => {
    const calls: string[] = [];
    const steps: DeletionSteps = {
      cancelSubscriptions: async () => { throw new Error("Stripe indisponible"); },
      deleteAuthUser: async () => void calls.push("delete"),
    };
    await assert.rejects(performDeletion("u", steps), /Stripe indisponible/);
    assert.deepEqual(calls, []);
  });

  it("si la suppression échoue, l'erreur remonte", async () => {
    const steps: DeletionSteps = { cancelSubscriptions: async () => 0, deleteAuthUser: async () => { throw new Error("auth down"); } };
    await assert.rejects(performDeletion("u", steps), /auth down/);
  });
});

describe("recordPrivacyRequest", () => {
  it("écrit une ligne avec la date de fin", async () => {
    const inserted: unknown[] = [];
    const db: PrivacyRequestDb = { from: (table) => ({ insert: async (row) => (inserted.push([table, row]), { error: null }) }) };
    await recordPrivacyRequest({ kind: "export", status: "completed", user_id: "u" }, db);
    const [table, row] = inserted[0] as [string, Record<string, unknown>];
    assert.equal(table, "privacy_requests");
    assert.equal(row.kind, "export");
    assert.ok(typeof row.completed_at === "string");
  });

  it("ne lève jamais : table absente, erreur ou exception", async () => {
    const silent = async (fn: () => Promise<void>) => {
      const original = console.error;
      console.error = () => {};
      try { await fn(); } finally { console.error = original; }
    };
    const record = { kind: "deletion" as const, status: "completed" as const };
    await silent(() => recordPrivacyRequest(record, { from: () => ({ insert: async () => ({ error: { code: "42P01" } }) }) }));
    await silent(() => recordPrivacyRequest(record, { from: () => ({ insert: async () => ({ error: { message: "boom" } }) }) }));
    await silent(() => recordPrivacyRequest(record, { from: () => ({ insert: async () => { throw new Error("réseau"); } }) }));
  });
});
