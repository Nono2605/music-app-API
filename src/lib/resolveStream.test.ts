import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStream, STREAM_URL_SECONDS, type SourceFile, type StreamDeps } from "./resolveStream";
import { cdnSignature } from "./cdnToken";

const CDN = { baseUrl: "https://cdn.vynl.li", secret: "secret-de-test" };
const FILE: SourceFile = { id: "f1", storage_key: "artist/orig.mp3", format: "mp3" };
const NOW = 1_800_000_000;

function deps(over: Partial<StreamDeps> = {}) {
  const calls = { renditions: 0, original: 0, errors: [] as unknown[] };
  const base: StreamDeps = {
    loadSourceFile: async () => FILE,
    loadRenditions: async () => {
      calls.renditions += 1;
      return [
        { storage_key: "t/x/f1-128.m4a", bitrate_kbps: 128 },
        { storage_key: "t/x/f1-256.m4a", bitrate_kbps: 256 },
      ];
    },
    signOriginal: async (file) => {
      calls.original += 1;
      return `https://supabase.example/sign/${file.storage_key}`;
    },
    nowSeconds: () => NOW,
    onCdnError: (err) => calls.errors.push(err),
    ...over,
  };
  return { deps: base, calls };
}

describe("resolveStream", () => {
  it("sert la version AAC du CDN, signée, pour la qualité demandée", async () => {
    const { deps: d, calls } = deps();
    const stream = await resolveStream(d, CDN, "t1", "high");
    const expires = NOW + STREAM_URL_SECONDS;
    assert.deepEqual(stream, {
      url: `https://cdn.vynl.li/t/x/f1-256.m4a?e=${expires}&s=${cdnSignature(CDN.secret, "t/x/f1-256.m4a", expires)}`,
      format: "m4a",
      delivery: "cdn",
    });
    assert.equal(calls.original, 0);
  });

  it("qualité standard : la version 128", async () => {
    const { deps: d } = deps();
    const stream = await resolveStream(d, CDN, "t1", "standard");
    assert.match(stream!.url, /\/t\/x\/f1-128\.m4a\?/);
  });

  it("aucune version prête : le fichier original chez Supabase", async () => {
    const { deps: d } = deps({ loadRenditions: async () => [] });
    const stream = await resolveStream(d, CDN, "t1", "standard");
    assert.deepEqual(stream, { url: "https://supabase.example/sign/artist/orig.mp3", format: "mp3", delivery: "supabase" });
  });

  it("CDN non réglé : on ne regarde même pas les versions", async () => {
    const { deps: d, calls } = deps();
    const stream = await resolveStream(d, undefined, "t1", "standard");
    assert.equal(stream!.delivery, "supabase");
    assert.equal(calls.renditions, 0);
  });

  it("panne en cherchant les versions (table absente, base lente) : repli sur Supabase, erreur signalée", async () => {
    const boom = new Error("relation track_renditions does not exist");
    const { deps: d, calls } = deps({
      loadRenditions: async () => {
        throw boom;
      },
    });
    const stream = await resolveStream(d, CDN, "t1", "standard");
    assert.equal(stream!.delivery, "supabase");
    assert.deepEqual(calls.errors, [boom]);
  });

  it("clé de version invalide : repli sur Supabase plutôt qu'une erreur", async () => {
    const { deps: d, calls } = deps({ loadRenditions: async () => [{ storage_key: "../etc/passwd", bitrate_kbps: 128 }] });
    const stream = await resolveStream(d, CDN, "t1", "standard");
    assert.equal(stream!.delivery, "supabase");
    assert.equal(calls.errors.length, 1);
  });

  it("morceau sans fichier : null, sans rien signer", async () => {
    const { deps: d, calls } = deps({ loadSourceFile: async () => null });
    assert.equal(await resolveStream(d, CDN, "t1", "standard"), null);
    assert.equal(calls.original, 0);
    assert.equal(calls.renditions, 0);
  });

  it("une panne de Supabase (fichier original) reste une erreur : rien d'autre à servir", async () => {
    const { deps: d } = deps({
      loadRenditions: async () => [],
      signOriginal: async () => {
        throw new Error("storage down");
      },
    });
    await assert.rejects(() => resolveStream(d, CDN, "t1", "standard"), /storage down/);
  });
});
