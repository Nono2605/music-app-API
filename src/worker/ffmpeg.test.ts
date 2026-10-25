import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAacArgs, runFfmpeg } from "./ffmpeg";

// ffmpeg du paquet ffmpeg-static (celui du worker en production), ou FFMPEG_PATH ; sans lui, les essais réels sont ignorés.
const FFMPEG: string | null = process.env.FFMPEG_PATH || require("ffmpeg-static");
const skip = FFMPEG ? false : "ffmpeg indisponible";

describe("buildAacArgs", () => {
  it("AAC en MP4 à démarrage rapide, sans image ni étiquettes, en stéréo 44,1 kHz", () => {
    const args = buildAacArgs("/in/source", "/out/a.m4a", 128);
    const joined = args.join(" ");
    assert.match(joined, /-i \/in\/source/);
    assert.match(joined, /-c:a aac -b:a 128k/);
    assert.match(joined, /-vn/);
    assert.match(joined, /-map_metadata -1/);
    assert.match(joined, /-ac 2 -ar 44100/);
    assert.match(joined, /-movflags \+faststart/);
    assert.equal(args.at(-1), "/out/a.m4a");
    assert.ok(args.includes("-nostdin"));
  });

  it("n'écrit jamais dans un fichier d'entrée : -y ne concerne que la sortie, donnée en dernier", () => {
    const args = buildAacArgs("/in/source", "/out/a.m4a", 256);
    assert.equal(args.indexOf("/out/a.m4a"), args.length - 1);
    assert.ok(args.indexOf("-y") < args.indexOf("-i"));
  });
});

describe("runFfmpeg (ffmpeg réel)", { skip }, () => {
  let dir: string;
  let source: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "vynl-ffmpeg-test-"));
    source = join(dir, "source.wav");
    // 3 secondes de son (un la à 440 Hz), généré par ffmpeg lui-même.
    await runFfmpeg(FFMPEG!, ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "48000", source]);
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const kbps of [128, 256]) {
    it(`produit un .m4a AAC de ${kbps} kbit/s, de la bonne durée, lisible par music-metadata`, async () => {
      const output = join(dir, `out-${kbps}.m4a`);
      await runFfmpeg(FFMPEG!, buildAacArgs(source, output, kbps));
      assert.ok((await stat(output)).size > 1000);

      const { parseFile } = await import("music-metadata");
      const info = (await parseFile(output, { duration: true })).format;
      assert.match(String(info.codec), /aac/i);
      assert.equal(info.numberOfChannels, 2);
      assert.equal(info.sampleRate, 44100);
      assert.ok(Math.abs((info.duration ?? 0) - 3) < 0.2, `durée ${info.duration}`);
      assert.ok(info.bitrate && Math.abs(info.bitrate / 1000 - kbps) < kbps * 0.35, `débit ${info.bitrate}`);
    });
  }

  it("place l'index (moov) avant les données (mdat) : la lecture démarre sans tout télécharger", async () => {
    const output = join(dir, "faststart.m4a");
    await runFfmpeg(FFMPEG!, buildAacArgs(source, output, 128));
    const bytes = await readFile(output);
    const moov = bytes.indexOf("moov");
    const mdat = bytes.indexOf("mdat");
    assert.ok(moov > 0 && mdat > 0, "moov et mdat trouvés");
    assert.ok(moov < mdat, `moov (${moov}) doit précéder mdat (${mdat})`);
  });

  it("un fichier qui n'est pas de l'audio : erreur claire, pas de sortie", async () => {
    const garbage = join(dir, "garbage");
    await writeFile(garbage, "ceci n'est pas de l'audio");
    const output = join(dir, "garbage.m4a");
    await assert.rejects(() => runFfmpeg(FFMPEG!, buildAacArgs(garbage, output, 128)), /ffmpeg a échoué/);
  });

  it("un ffmpeg introuvable : erreur claire", async () => {
    await assert.rejects(() => runFfmpeg("/nulle/part/ffmpeg", ["-version"]), /ne démarre pas/);
  });

  it("une tâche trop longue est interrompue", async () => {
    // Une source infinie (aucune durée) encodée vers un fichier : ne se termine jamais, le délai la coupe.
    await assert.rejects(
      () => runFfmpeg(FFMPEG!, ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440", "-f", "null", "-"], 700),
      /interrompu/
    );
  });
});
