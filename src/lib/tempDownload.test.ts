import { readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { downloadToTempFile } from "./tempDownload";

const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("vynl-fingerprint-")).length;

const fetchOf = (respond: () => Response | Promise<Response>) => (async () => respond()) as unknown as typeof fetch;

describe("downloadToTempFile", () => {
  it("écrit le fichier reçu dans un dossier temporaire, et cleanup() le supprime", async () => {
    const file = await downloadToTempFile("https://signed.example/a", { fetchImpl: fetchOf(() => new Response("audio-bytes")) });

    assert.equal(readFileSync(file.path, "utf8"), "audio-bytes");
    await file.cleanup();
    assert.equal(existsSync(file.path), false);
  });

  it("une erreur HTTP lève, sans rien laisser derrière", async () => {
    const before = leftovers();
    await assert.rejects(
      () => downloadToTempFile("https://signed.example/a", { fetchImpl: fetchOf(() => new Response("no", { status: 400 })) }),
      /download failed \(HTTP 400\)/
    );
    assert.equal(leftovers(), before);
  });

  it("un réseau coupé lève, sans citer l'adresse (elle est signée)", async () => {
    await assert.rejects(
      () => downloadToTempFile("https://signed.example/a?token=SECRET", { fetchImpl: (async () => { throw new Error("fetch failed"); }) as unknown as typeof fetch }),
      (err: unknown) => err instanceof Error && /download failed: fetch failed/.test(err.message) && !/SECRET|signed\.example/.test(err.message)
    );
  });

  it("un fichier annoncé trop gros est refusé avant d'être lu", async () => {
    const before = leftovers();
    await assert.rejects(
      () =>
        downloadToTempFile("https://signed.example/a", {
          maxBytes: 10,
          fetchImpl: fetchOf(() => new Response("x".repeat(5), { headers: { "content-length": "999" } })),
        }),
      /larger than the maximum/
    );
    assert.equal(leftovers(), before);
  });

  it("un fichier qui dépasse la taille en cours de route est interrompu et supprimé", async () => {
    const before = leftovers();
    await assert.rejects(
      () => downloadToTempFile("https://signed.example/a", { maxBytes: 10, fetchImpl: fetchOf(() => new Response("x".repeat(100))) }),
      /larger than the maximum/
    );
    assert.equal(leftovers(), before);
  });

  it("un fichier vide est refusé", async () => {
    const before = leftovers();
    await assert.rejects(() => downloadToTempFile("https://signed.example/a", { fetchImpl: fetchOf(() => new Response("")) }), /empty|download failed/);
    assert.equal(leftovers(), before);
  });
});
