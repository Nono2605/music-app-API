import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createAccountRouter, type AccountDeps } from "./accountRouter";
import type { PrivacyRequestRecord } from "../../lib/privacyRequests";

// Un serveur réel sur un port libre, avec une authentification factice (le compte « u1 »).
async function withServer<T>(overrides: Partial<AccountDeps>, run: (base: string, log: { calls: string[]; records: PrivacyRequestRecord[] }) => Promise<T>) {
  const log = { calls: [] as string[], records: [] as PrivacyRequestRecord[] };
  const deps: AccountDeps = {
    authenticate: (req, _res, next) => { req.auth = { id: "u1", email: "me@example.com" }; next(); },
    loadUser: async () => ({ email: "me@example.com", role: "listener" }),
    exportAccount: async (userId) => ({ account_id: userId, library: [] }),
    steps: {
      cancelSubscriptions: async () => (log.calls.push("cancel"), 1),
      deleteAuthUser: async () => void log.calls.push("delete"),
    },
    record: async (record) => void log.records.push(record),
    billingFailure: () => null,
    now: () => new Date("2026-10-13T09:00:00Z"),
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use("/", createAccountRouter(deps));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
    void err;
  });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, log);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/me/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("GET /me/export", () => {
  it("renvoie le document en téléchargement, sans mise en cache, et journalise la demande", async () => {
    await withServer({}, async (base, log) => {
      const res = await fetch(`${base}/me/export`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="vynl-data-2026-10-13\.json"/);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      assert.deepEqual(await res.json(), { account_id: "u1", library: [] });
      assert.deepEqual(log.records, [{ kind: "export", status: "completed", user_id: "u1" }]);
    });
  });

  it("une erreur interne ne journalise rien et répond 500 générique", async () => {
    await withServer({ exportAccount: async () => { throw new Error("secret detail"); } }, async (base, log) => {
      const res = await fetch(`${base}/me/export`);
      assert.equal(res.status, 500);
      assert.doesNotMatch(await res.text(), /secret detail/);
      assert.deepEqual(log.records, []);
    });
  });
});

describe("POST /me/delete", () => {
  it("avec la bonne adresse : annule l'abonnement, supprime, journalise sans compte", async () => {
    await withServer({}, async (base, log) => {
      const res = await post(base, { confirm_email: "ME@example.com" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { deleted: true, subscriptions_cancelled: 1 });
      assert.deepEqual(log.calls, ["cancel", "delete"]);
      assert.deepEqual(log.records, [{ kind: "deletion", status: "completed", user_id: null, detail: { subscriptions_cancelled: 1 } }]);
    });
  });

  it("sans bonne confirmation : 400 et RIEN n'est supprimé ni annulé", async () => {
    await withServer({}, async (base, log) => {
      for (const body of [{}, { confirm_email: "autre@example.com" }, { confirm_email: "" }]) {
        const res = await post(base, body);
        assert.equal(res.status, 400);
        assert.equal(((await res.json()) as { code: string }).code, "confirmation_mismatch");
      }
      assert.deepEqual(log.calls, []);
      assert.deepEqual(log.records, []);
    });
  });

  it("un administrateur : 403, rien n'est supprimé", async () => {
    await withServer({ loadUser: async () => ({ email: "me@example.com", role: "admin" }) }, async (base, log) => {
      const res = await post(base, { confirm_email: "me@example.com" });
      assert.equal(res.status, 403);
      assert.deepEqual(log.calls, []);
    });
  });

  it("compte introuvable : 404", async () => {
    await withServer({ loadUser: async () => null }, async (base) => {
      assert.equal((await post(base, { confirm_email: "me@example.com" })).status, 404);
    });
  });

  it("l'annulation chez Stripe échoue : 502, rien n'est supprimé, la demande est journalisée en échec", async () => {
    const stripeDown = Object.assign(new Error("Stripe is down"), { type: "StripeAPIError" });
    await withServer(
      {
        steps: { cancelSubscriptions: async () => { throw stripeDown; }, deleteAuthUser: async () => { throw new Error("ne doit pas être appelé"); } },
        billingFailure: (err) => ((err as { type?: string }).type === "StripeAPIError" ? { status: 502, body: { error: "not cancelled", code: "billing_provider_error" } } : null),
      },
      async (base, log) => {
        const res = await post(base, { confirm_email: "me@example.com" });
        assert.equal(res.status, 502);
        assert.equal(((await res.json()) as { code: string }).code, "billing_provider_error");
        assert.deepEqual(log.records, [{ kind: "deletion", status: "failed", user_id: "u1" }]);
      }
    );
  });

  it("une autre erreur : 500 générique, et la demande est journalisée en échec", async () => {
    await withServer({ steps: { cancelSubscriptions: async () => 0, deleteAuthUser: async () => { throw new Error("auth down"); } } }, async (base, log) => {
      const res = await post(base, { confirm_email: "me@example.com" });
      assert.equal(res.status, 500);
      assert.deepEqual(log.records, [{ kind: "deletion", status: "failed", user_id: "u1" }]);
    });
  });
});
