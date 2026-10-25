import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  it("se place dans le fichier avant de le lire, coupe la durée voulue, écrit un WAV PCM mono dans le fichier demandé", () => {
    const args = buildSampleArgs("/tmp/audio", 44, 12, "/tmp/out/sample.wav");
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss avant -i (accès direct)");
    assert.equal(args[args.indexOf("-ss") + 1], "44");
    assert.equal(args[args.indexOf("-t") + 1], "12");
    assert.equal(args[args.indexOf("-i") + 1], "/tmp/audio");
    assert.equal(args[args.indexOf("-ac") + 1], "1");
    assert.equal(args[args.indexOf("-c:a") + 1], "pcm_s16le");
    assert.equal(args[args.indexOf("-f") + 1], "wav");
    assert.equal(args.at(-1), "/tmp/out/sample.wav");
    assert.ok(args.includes("-y") && args.includes("-vn") && args.includes("-nostdin"));
  });

  it("n'a besoin d'aucun encodeur à installer (pas de libmp3lame)", () => {
    assert.ok(!buildSampleArgs("x", 0, 12, "y").some((arg) => /mp3|lame/i.test(arg)));
  });

  it("un début négatif est ramené à zéro", () => {
    const args = buildSampleArgs("x", -5, 12, "y");
    assert.equal(args[args.indexOf("-ss") + 1], "0");
  });
});

// Un vrai ffmpeg (celui du paquet ffmpeg-static, ou FFMPEG_PATH) : sans lui, ces essais sont ignorés.
const FFMPEG: string | null = process.env.FFMPEG_PATH || require("ffmpeg-static");
const real = FFMPEG ? it : it.skip;

describe("cutSample avec un vrai ffmpeg", () => {
  const dir = mkdtempSync(join(tmpdir(), "vynl-samples-test-"));

  real("découpe un extrait WAV de la bonne durée dans un fichier local", async () => {
    const source = join(dir, "tone.wav");
    const made = spawnSync(FFMPEG!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-y", source]);
    assert.equal(made.status, 0, String(made.stderr));

    const sample = await cutSample(FFMPEG!, source, 2, 3);

    assert.equal(sample.subarray(0, 4).toString("latin1"), "RIFF");
    assert.equal(sample.subarray(8, 12).toString("latin1"), "WAVE");
    // 3 secondes de PCM 16 bits mono à 16 kHz : 96 000 octets, plus l'en-tête.
    assert.ok(Math.abs(sample.length - 96_000) < 2_000, `taille inattendue : ${sample.length}`);
  });

  real("ne laisse aucun dossier temporaire derrière lui, ni en cas de succès ni en cas d'échec", async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("vynl-sample-") && !name.includes("test")).length;
    const source = join(dir, "tone2.wav");
    spawnSync(FFMPEG!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-y", source]);

    await cutSample(FFMPEG!, source, 0, 2);
    await assert.rejects(() => cutSample(FFMPEG!, join(dir, "absent"), 0, 2));

    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("vynl-sample-") && !name.includes("test")).length;
    assert.equal(after, before);
  });

  real("un fichier illisible fait échouer avec le code de sortie, sans citer d'adresse", async () => {
    await assert.rejects(
      () => cutSample(FFMPEG!, "https://127.0.0.1:1/nothing.mp3?token=SECRET", 0, 3, 20_000),
      (err: unknown) => err instanceof Error && /ffmpeg failed \(code \d+\)/.test(err.message) && !/SECRET/.test(err.message)
    );
  });

  it("ffmpeg tué par un signal : le message nomme le signal (et non « code null »), avec la piste de la mémoire pour SIGKILL", async () => {
    const killed = join(dir, "fake-ffmpeg-killed");
    writeFileSync(killed, "#!/bin/sh\nkill -9 $$\n");
    chmodSync(killed, 0o755);
    await assert.rejects(
      () => cutSample(killed, "/tmp/whatever", 0, 3, 20_000),
      (err: unknown) => err instanceof Error && /killed by SIGKILL, often out of memory/.test(err.message) && !/null/.test(err.message)
    );

    const crashed = join(dir, "fake-ffmpeg-segv");
    writeFileSync(crashed, "#!/bin/sh\nkill -SEGV $$\n");
    chmodSync(crashed, 0o755);
    await assert.rejects(() => cutSample(crashed, "/tmp/whatever", 0, 3, 20_000), /crashed with SIGSEGV/);
  });

  it("un ffmpeg qui refuse : le code de sortie et son message sont rendus", async () => {
    const refusing = join(dir, "fake-ffmpeg-refuses");
    writeFileSync(refusing, "#!/bin/sh\necho 'Invalid data found' >&2\nexit 3\n");
    chmodSync(refusing, 0o755);
    await assert.rejects(() => cutSample(refusing, "/tmp/whatever", 0, 3, 20_000), /ffmpeg failed \(code 3\): Invalid data found/);
  });

  it("un ffmpeg absent : message clair", async () => {
    await assert.rejects(() => cutSample(join(dir, "does-not-exist"), "/tmp/whatever", 0, 3, 20_000), /ffmpeg does not start/);
  });

  it("nettoyage", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
