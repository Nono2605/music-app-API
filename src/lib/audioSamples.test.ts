import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSampleArgs, cutSample, sampleOffsets } from "./audioSamples";

describe("sampleOffsets", () => {
  it("trois extraits répartis dans un morceau de trois minutes, ni au tout début ni à la toute fin", () => {
    const offsets = sampleOffsets(200);
    assert.equal(offsets.length, 3);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
    assert.ok(offsets[0] > 0 && offsets[2] + 12 < 200);
    // Centrés sur le quart, la moitié et les trois quarts du morceau.
    assert.deepEqual(offsets, [44, 94, 144]);
  });

  it("un morceau court reçoit moins d'extraits, un très court un seul", () => {
    assert.equal(sampleOffsets(20).length, 1);
    assert.equal(sampleOffsets(30).length, 2);
    assert.deepEqual(sampleOffsets(10), [0]);
  });

  it("sans durée connue : un seul extrait, au début", () => {
    assert.deepEqual(sampleOffsets(null), [0]);
    assert.deepEqual(sampleOffsets(0), [0]);
    assert.deepEqual(sampleOffsets(Number.NaN), [0]);
  });

  it("un extrait ne dépasse jamais la fin du morceau, et il n'y a pas de doublon", () => {
    for (const duration of [13, 25, 37, 61, 240, 3600]) {
      const offsets = sampleOffsets(duration);
      assert.equal(new Set(offsets).size, offsets.length);
      for (const start of offsets) assert.ok(start >= 0 && start + 12 <= duration, `${duration}: ${start}`);
    }
  });

  it("le nombre d'extraits est réglable", () => {
    assert.equal(sampleOffsets(600, 5).length, 5);
    assert.equal(sampleOffsets(600, 1).length, 1);
  });
});

describe("buildSampleArgs", () => {
  it("se place dans le fichier avant de le lire, coupe la durée voulue, sort un mp3 mono sur la sortie standard", () => {
    const args = buildSampleArgs("https://example.com/a.mp3", 44);
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss avant -i (accès direct)");
    assert.equal(args[args.indexOf("-ss") + 1], "44");
    assert.equal(args[args.indexOf("-t") + 1], "12");
    assert.equal(args[args.indexOf("-i") + 1], "https://example.com/a.mp3");
    assert.equal(args[args.indexOf("-ac") + 1], "1");
    assert.equal(args.at(-1), "pipe:1");
    assert.ok(args.includes("-vn") && args.includes("-nostdin"));
  });

  it("un début négatif est ramené à zéro", () => {
    assert.equal(buildSampleArgs("x", -5)[buildSampleArgs("x", -5).indexOf("-ss") + 1], "0");
  });
});

// Un vrai ffmpeg (celui du paquet ffmpeg-static, ou FFMPEG_PATH) : sans lui, ces essais sont ignorés.
const FFMPEG: string | null = process.env.FFMPEG_PATH || require("ffmpeg-static");
const real = FFMPEG ? it : it.skip;

describe("cutSample avec un vrai ffmpeg", () => {
  const dir = mkdtempSync(join(tmpdir(), "vynl-samples-"));

  real("découpe un extrait mp3 non vide d'un fichier", async () => {
    const source = join(dir, "tone.wav");
    const made = spawnSync(FFMPEG!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-y", source]);
    assert.equal(made.status, 0, String(made.stderr));

    const sample = await cutSample(FFMPEG!, source, 2, 3);

    assert.ok(sample.length > 1000, `trop petit : ${sample.length}`);
    // Un mp3 commence par une étiquette ID3 ou par un en-tête de trame (11 bits à 1).
    assert.ok(sample.subarray(0, 3).toString("latin1") === "ID3" || (sample[0] === 0xff && (sample[1] & 0xe0) === 0xe0));
  });

  real("un fichier illisible fait échouer, sans citer d'adresse", async () => {
    await assert.rejects(
      () => cutSample(FFMPEG!, "https://127.0.0.1:1/nothing.mp3?token=SECRET", 0, 3, 20_000),
      (err: unknown) => err instanceof Error && /ffmpeg failed/.test(err.message) && !/SECRET/.test(err.message)
    );
  });

  it("nettoyage", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
