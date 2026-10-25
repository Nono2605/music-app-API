import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { drainDeletions, processTask, retryDelaySeconds, type DeletionIo, type RenditionRow, type TranscodeIo, type TranscodeTask } from "./transcodeJob";

const TASK: TranscodeTask = {
  jobId: "j1",
  fileId: "f0000000-0000-4000-8000-000000000001",
  trackId: "00000000-0000-4000-8000-000000000001",
  storageKey: "artist/original.flac",
};

function fakeIo(over: Partial<TranscodeIo> = {}) {
  const log = { downloads: [] as string[], encodes: [] as number[], uploads: [] as string[], removed: [] as string[], saved: [] as RenditionRow[], cleanups: 0 };
  const io: TranscodeIo = {
    existingBitrates: async () => [],
    makeWorkDir: async () => ({
      dir: "/work",
      cleanup: async () => {
        log.cleanups += 1;
      },
    }),
    download: async (key) => {
      log.downloads.push(key);
    },
    probeDuration: async () => 200.4,
    encode: async (_in, _out, kbps) => {
      log.encodes.push(kbps);
    },
    fileSize: async () => 5_000_000,
    upload: async (key) => {
      log.uploads.push(key);
    },
    removeUploaded: async (key) => {
      log.removed.push(key);
    },
    saveRendition: async (row) => {
      log.saved.push(row);
    },
    ...over,
  };
  return { io, log };
}

describe("processTask", () => {
  it("produit les deux versions, les dépose sur R2 puis les inscrit", async () => {
    const { io, log } = fakeIo();
    const result = await processTask(io, TASK);
    assert.deepEqual(result, { produced: [128, 256], alreadyThere: [] });
    assert.deepEqual(log.downloads, ["artist/original.flac"]);
    assert.deepEqual(log.encodes, [128, 256]);
    assert.deepEqual(log.uploads, [`t/${TASK.trackId}/${TASK.fileId}-128.m4a`, `t/${TASK.trackId}/${TASK.fileId}-256.m4a`]);
    assert.deepEqual(log.saved[0], {
      track_id: TASK.trackId,
      source_file_id: TASK.fileId,
      bitrate_kbps: 128,
      storage_key: `t/${TASK.trackId}/${TASK.fileId}-128.m4a`,
      file_size_bytes: 5_000_000,
      duration_seconds: 200,
    });
    assert.equal(log.cleanups, 1);
  });

  it("reprise après un plantage : ne refait pas la version déjà prête", async () => {
    const { io, log } = fakeIo({ existingBitrates: async () => [128] });
    const result = await processTask(io, TASK);
    assert.deepEqual(result, { produced: [256], alreadyThere: [128] });
    assert.deepEqual(log.encodes, [256]);
  });

  it("tout est déjà prêt : rien n'est téléchargé", async () => {
    const { io, log } = fakeIo({ existingBitrates: async () => [128, 256] });
    const result = await processTask(io, TASK);
    assert.deepEqual(result, { produced: [], alreadyThere: [128, 256] });
    assert.deepEqual(log.downloads, []);
    assert.equal(log.cleanups, 0);
  });

  it("une version trop courte (tronquée) est refusée : rien déposé, rien inscrit", async () => {
    let calls = 0;
    const { io, log } = fakeIo({
      probeDuration: async () => (calls++ === 0 ? 200 : 120),
    });
    await assert.rejects(() => processTask(io, TASK), /refusée/);
    assert.deepEqual(log.uploads, []);
    assert.deepEqual(log.saved, []);
    assert.equal(log.cleanups, 1);
  });

  it("une durée à moins de deux secondes de l'original est acceptée (remplissage de l'AAC)", async () => {
    let calls = 0;
    const { io } = fakeIo({ probeDuration: async () => (calls++ === 0 ? 200 : 201.5) });
    await assert.doesNotReject(() => processTask(io, TASK, [128]));
  });

  it("un fichier vide est refusé", async () => {
    const { io, log } = fakeIo({ fileSize: async () => 0 });
    await assert.rejects(() => processTask(io, TASK), /vide/);
    assert.deepEqual(log.uploads, []);
  });

  it("inscription refusée : le fichier déposé est retiré de R2, l'erreur remonte", async () => {
    const boom = new Error("violates foreign key constraint");
    const { io, log } = fakeIo({
      saveRendition: async () => {
        throw boom;
      },
    });
    await assert.rejects(() => processTask(io, TASK), boom);
    assert.deepEqual(log.removed, [`t/${TASK.trackId}/${TASK.fileId}-128.m4a`]);
    assert.equal(log.cleanups, 1);
  });

  it("un échec du retrait ne masque pas l'erreur d'origine", async () => {
    const boom = new Error("base en panne");
    const { io } = fakeIo({
      saveRendition: async () => {
        throw boom;
      },
      removeUploaded: async () => {
        throw new Error("R2 en panne aussi");
      },
    });
    await assert.rejects(() => processTask(io, TASK), boom);
  });

  it("ffmpeg qui échoue : le dossier de travail est nettoyé quand même", async () => {
    const { io, log } = fakeIo({
      encode: async () => {
        throw new Error("ffmpeg a échoué");
      },
    });
    await assert.rejects(() => processTask(io, TASK), /ffmpeg a échoué/);
    assert.equal(log.cleanups, 1);
    assert.deepEqual(log.uploads, []);
  });

  it("la première version reste inscrite si la seconde échoue (reprise partielle)", async () => {
    const { io, log } = fakeIo({
      encode: async (_in, _out, kbps) => {
        if (kbps === 256) throw new Error("disque plein");
      },
    });
    await assert.rejects(() => processTask(io, TASK), /disque plein/);
    assert.equal(log.saved.length, 1);
    assert.equal(log.saved[0].bitrate_kbps, 128);
  });
});

describe("drainDeletions", () => {
  function deletionIo(over: Partial<DeletionIo> = {}) {
    const log = { deleted: [] as string[], removed: [] as number[], failed: [] as [number, string, number][] };
    const io: DeletionIo = {
      list: async () => [
        { id: 1, storage_key: "k1", attempts: 0 },
        { id: 2, storage_key: "k2", attempts: 4 },
      ],
      deleteObject: async (key) => {
        log.deleted.push(key);
      },
      remove: async (id) => {
        log.removed.push(id);
      },
      markFailed: async (id, message, attempts) => {
        log.failed.push([id, message, attempts]);
      },
      ...over,
    };
    return { io, log };
  }

  it("supprime chaque fichier de R2 puis le retire de la file", async () => {
    const { io, log } = deletionIo();
    assert.deepEqual(await drainDeletions(io), { deleted: 2, failed: 0 });
    assert.deepEqual(log.deleted, ["k1", "k2"]);
    assert.deepEqual(log.removed, [1, 2]);
  });

  it("une clé qui échoue reste dans la file (essais comptés) sans arrêter les autres", async () => {
    const { io, log } = deletionIo({
      deleteObject: async (key) => {
        if (key === "k1") throw new Error("R2 injoignable");
      },
    });
    assert.deepEqual(await drainDeletions(io), { deleted: 1, failed: 1 });
    assert.deepEqual(log.removed, [2]);
    assert.deepEqual(log.failed, [[1, "R2 injoignable", 1]]);
  });

  it("ne retire pas de la file un fichier dont la suppression a échoué", async () => {
    const { io, log } = deletionIo({
      deleteObject: async () => {
        throw new Error("non");
      },
    });
    await drainDeletions(io);
    assert.deepEqual(log.removed, []);
  });
});

describe("retryDelaySeconds", () => {
  it("5 minutes après le premier échec, 10 après le deuxième", () => {
    assert.equal(retryDelaySeconds(1), 300);
    assert.equal(retryDelaySeconds(2), 600);
    assert.equal(retryDelaySeconds(0), 300);
  });
});
