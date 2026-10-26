import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countOpenScanJobs, enqueueOneTrackScan, enqueueTrackScans, type CountDb, type RpcDb } from "./scanQueue";

// Un faux client dont la fonction `enqueue_track_scans` répond selon le morceau.
function fakeRpc(answer: (trackId: string) => { data?: unknown; error?: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: RpcDb = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      const { data = null, error = null } = answer(String(args.p_track));
      return Promise.resolve({ data, error });
    },
  };
  return { db, calls };
}

describe("enqueueTrackScans", () => {
  it("met chaque morceau en file, une seule fois même s'il est donné deux fois", async () => {
    const { db, calls } = fakeRpc((id) => ({ data: `job-${id}` }));

    const queued = await enqueueTrackScans(["t1", "t2", "t1"], "submit", db);

    assert.equal(queued, 2);
    assert.deepEqual(calls.map((c) => c.args), [
      { p_track: "t1", p_reason: "submit" },
      { p_track: "t2", p_reason: "submit" },
    ]);
  });

  it("un morceau déjà en file (la base rend null) ne compte pas", async () => {
    const { db } = fakeRpc((id) => ({ data: id === "t1" ? null : "job" }));

    assert.equal(await enqueueTrackScans(["t1", "t2"], "manual", db), 1);
  });

  it("la file n'existe pas encore (migration pas appliquée) : rien n'est lancé, rien ne lève, on s'arrête là", async () => {
    const { db, calls } = fakeRpc(() => ({ error: { code: "PGRST202" } }));

    assert.equal(await enqueueTrackScans(["t1", "t2"], "submit", db), 0);
    assert.equal(calls.length, 1);
  });

  it("une autre panne ne lève pas (l'artiste n'est jamais bloqué) et les morceaux suivants sont tentés", async () => {
    const { db } = fakeRpc((id) => (id === "t1" ? { error: { message: "boom" } } : { data: "job" }));

    assert.equal(await enqueueTrackScans(["t1", "t2"], "submit", db), 1);
  });

  it("un rejet réseau ne lève pas non plus", async () => {
    const db: RpcDb = { rpc: () => Promise.reject(new Error("socket hang up")) };

    assert.equal(await enqueueTrackScans(["t1"], "submit", db), 0);
  });
});

describe("enqueueOneTrackScan : dit ce qui s'est vraiment passé", () => {
  it("tâche créée : queued", async () => {
    const { db } = fakeRpc(() => ({ data: "job-1" }));
    assert.equal(await enqueueOneTrackScan("t1", "manual", db), "queued");
  });

  it("une tâche attend déjà (la base rend null) : already_open, pas « queued »", async () => {
    const { db } = fakeRpc(() => ({ data: null }));
    assert.equal(await enqueueOneTrackScan("t1", "manual", db), "already_open");
  });

  it("la file n'existe pas (fonction ou table absente) : unavailable, pas « déjà en file »", async () => {
    for (const code of ["PGRST202", "42883", "42P01", "PGRST205"]) {
      const { db } = fakeRpc(() => ({ error: { code } }));
      assert.equal(await enqueueOneTrackScan("t1", "manual", db), "unavailable", code);
    }
  });

  it("toute autre panne : error, sans lever", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const { db } = fakeRpc(() => ({ error: { message: "boom" } }));
      assert.equal(await enqueueOneTrackScan("t1", "manual", db), "error");
      const rejecting: RpcDb = { rpc: () => Promise.reject(new Error("socket hang up")) };
      assert.equal(await enqueueOneTrackScan("t1", "manual", rejecting), "error");
    } finally {
      console.error = quiet;
    }
  });
});

describe("countOpenScanJobs", () => {
  const countDb = (result: { count?: number | null; error?: unknown }): CountDb => ({
    from: () => ({ select: () => ({ in: () => Promise.resolve({ count: result.count ?? null, error: result.error ?? null }) }) }),
  });

  it("rend le nombre de tâches en attente ou en cours", async () => {
    assert.equal(await countOpenScanJobs(countDb({ count: 4 })), 4);
    assert.equal(await countOpenScanJobs(countDb({ count: null })), 0);
  });

  it("la table n'existe pas : null (et non zéro), pour que l'admin le dise", async () => {
    assert.equal(await countOpenScanJobs(countDb({ error: { code: "42P01" } })), null);
    assert.equal(await countOpenScanJobs(countDb({ error: { code: "PGRST205" } })), null);
  });

  it("une autre panne remonte", async () => {
    const boom = { code: "57014", message: "timeout" };
    await assert.rejects(() => countOpenScanJobs(countDb({ error: boom })), (err) => err === boom);
  });
});

