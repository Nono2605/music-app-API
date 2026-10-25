import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createScanRunner, processJob, type ScanJob, type ScanRunnerDeps } from "./scanRunner";
import type { ScanRecord } from "./scanLog";
import type { ScanContext, Scanner } from "./scanners";

const context: ScanContext = {
  track: { id: "t1", title: "Nova", duration_seconds: 200, artist_id: "a1" },
  files: [{ id: "f1", checksum: "ab".repeat(32), storage_key: "k" }],
};

function job(id: string, trackId = "t1"): ScanJob {
  return { jobId: id, trackId, reason: "submit", attempts: 1 };
}

const okScanner = (kind: string): Scanner => ({ kind, provider: "internal", run: async () => [{ result: "ok", detail: { n: 1 } }] });

// Des dépendances en mémoire : une file de tâches et le journal de ce qui s'est passé.
function fakeDeps(overrides: Partial<ScanRunnerDeps> = {}, queue: ScanJob[] = []) {
  const calls = { recorded: [] as ScanRecord[][], finished: [] as string[], failed: [] as { id: string; message: string }[], logs: [] as string[] };
  const deps: ScanRunnerDeps = {
    scanners: [okScanner("duplicate_audio"), okScanner("similar_title")],
    claim: async () => queue.shift() ?? null,
    loadContext: async () => context,
    record: async (records) => void calls.recorded.push(records),
    finish: async (j) => void calls.finished.push(j.jobId),
    fail: async (j, message) => void calls.failed.push({ id: j.jobId, message }),
    log: (message) => void calls.logs.push(message),
    ...overrides,
  };
  return { deps, calls };
}

describe("processJob", () => {
  it("écrit les résultats de tous les contrôles d'un coup, avec le morceau, l'artiste et la tâche", async () => {
    const { deps, calls } = fakeDeps();

    await processJob(deps, job("j1"));

    assert.equal(calls.recorded.length, 1);
    const [records] = calls.recorded;
    assert.deepEqual(records.map((r) => r.check_kind), ["duplicate_audio", "similar_title"]);
    for (const record of records) {
      assert.equal(record.track_id, "t1");
      assert.equal(record.artist_id, "a1");
      assert.equal(record.provider, "internal");
      assert.equal(record.result, "ok");
      assert.deepEqual(record.detail, { n: 1, job_id: "j1", reason: "submit" });
    }
    assert.deepEqual(calls.finished, ["j1"]);
  });

  it("un contrôle qui lève une erreur est journalisé « indisponible » (jamais « ok »), sans perdre les autres", async () => {
    const broken: Scanner = { kind: "fingerprint", provider: "acme", version: "2", run: async () => { throw new Error("provider down"); } };
    const { deps, calls } = fakeDeps({ scanners: [okScanner("similar_title"), broken] });

    await processJob(deps, job("j1"));

    const records = calls.recorded[0];
    assert.equal(records.length, 2);
    assert.equal(records[0].result, "ok");
    assert.equal(records[1].check_kind, "fingerprint");
    assert.equal(records[1].result, "warn");
    assert.equal(records[1].provider, "acme");
    assert.equal(records[1].provider_version, "2");
    assert.equal((records[1].detail as Record<string, unknown>).unavailable, true);
    assert.match(calls.logs[0], /fingerprint indisponible/);
    assert.deepEqual(calls.finished, ["j1"]);
  });

  it("un morceau supprimé entre-temps termine la tâche sans rien écrire", async () => {
    const { deps, calls } = fakeDeps({ loadContext: async () => null });

    await processJob(deps, job("j1"));

    assert.equal(calls.recorded.length, 0);
    assert.deepEqual(calls.finished, ["j1"]);
  });

  it("si le journal ne s'écrit pas, la tâche n'est PAS terminée (elle sera reprise)", async () => {
    const { deps, calls } = fakeDeps({ record: async () => { throw new Error("insert failed"); } });

    await assert.rejects(() => processJob(deps, job("j1")), /insert failed/);
    assert.deepEqual(calls.finished, []);
  });
});

describe("createScanRunner", () => {
  it("vide la file : toutes les tâches sont traitées", async () => {
    const { deps, calls } = fakeDeps({}, [job("j1"), job("j2"), job("j3")]);
    const runner = createScanRunner(deps);

    await runner.kick();

    assert.deepEqual(calls.finished, ["j1", "j2", "j3"]);
    assert.equal(runner.isRunning(), false);
  });

  it("une tâche en échec est rendue à la file avec la raison, et les suivantes sont traitées quand même", async () => {
    let loads = 0;
    const { deps, calls } = fakeDeps(
      { loadContext: async () => { if (loads++ === 0) throw new Error("db down"); return context; } },
      [job("j1"), job("j2")]
    );
    const wakeUps: number[] = [];
    const runner = createScanRunner(deps, { schedule: (_callback, delayMs) => void wakeUps.push(delayMs), retryDelayMs: 1234 });

    await runner.kick();

    assert.deepEqual(calls.failed, [{ id: "j1", message: "db down" }]);
    assert.deepEqual(calls.finished, ["j2"]);
    assert.deepEqual(wakeUps, [1234]);
  });

  it("ne programme qu'un seul réveil de reprise, même après plusieurs échecs", async () => {
    const { deps } = fakeDeps({ loadContext: async () => { throw new Error("db down"); } }, [job("j1"), job("j2"), job("j3")]);
    const wakeUps: number[] = [];
    const runner = createScanRunner(deps, { schedule: (_callback, delayMs) => void wakeUps.push(delayMs) });

    await runner.kick();

    assert.equal(wakeUps.length, 1);
  });

  it("un seul exécuteur à la fois : réveiller pendant un tour ne lance pas un second tour en parallèle, mais ne perd rien", async () => {
    const queue: ScanJob[] = [job("j1")];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let active = 0;
    let peak = 0;
    const { deps, calls } = fakeDeps(
      {
        loadContext: async () => {
          active++;
          peak = Math.max(peak, active);
          await gate;
          active--;
          return context;
        },
      },
      queue
    );
    const runner = createScanRunner(deps);

    const first = runner.kick();
    queue.push(job("j2")); // arrive pendant que j1 est en cours
    const second = runner.kick();
    assert.equal(runner.isRunning(), true);
    release();
    await Promise.all([first, second]);

    assert.equal(peak, 1);
    assert.deepEqual(calls.finished, ["j1", "j2"]);
  });

  it("une file illisible (migration pas appliquée, base en panne) arrête le tour sans lever d'erreur", async () => {
    const { deps, calls } = fakeDeps({ claim: async () => { throw new Error("relation does not exist"); } });
    const runner = createScanRunner(deps);

    await runner.kick();

    assert.match(calls.logs[0], /file des contrôles illisible/);
    assert.equal(runner.isRunning(), false);
  });

  it("s'arrête au plafond de tâches par tour", async () => {
    const queue = Array.from({ length: 5 }, (_, i) => job(`j${i}`));
    const { deps, calls } = fakeDeps({}, queue);
    const runner = createScanRunner(deps, { limits: { maxJobs: 2, maxMillis: 60_000 } });

    await runner.kick();

    assert.deepEqual(calls.finished, ["j0", "j1"]);
  });
});
