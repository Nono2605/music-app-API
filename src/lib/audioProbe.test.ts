import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { AudioProbeError, classifyAudio, probeAudioUrl } from "./audioProbe";

// Fichiers audio fabriqués ici : les tests ne dépendent d'aucun outil externe
// ni d'aucun fichier binaire versionné.

// WAV PCM 16 bits mono (silence).
function wav(seconds: number, sampleRate = 8000): Buffer {
  const data = Buffer.alloc(sampleRate * seconds * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// MP3 MPEG-1 Layer III, 128 kbps, 44,1 kHz, sans en-tête de durée : N trames de
// 417 octets, soit N × 1152 / 44100 secondes.
function mp3(frames: number): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

const files = new Map<string, Buffer>();
let server: Server;
let base: string;
const tmpDirsBefore = () => readdirSync(tmpdir()).filter((n) => n.startsWith("vynl-audio-")).length;
const leftoverBefore = tmpDirsBefore();

before(async () => {
  server = createServer((req, res) => {
    const file = files.get(req.url ?? "");
    if (!file) {
      // Le stockage répond 400, pas 404, pour un objet inexistant.
      res.writeHead(400, { "content-type": "application/json" });
      return res.end('{"statusCode":"404","error":"not_found"}');
    }
    res.writeHead(200, { "content-length": file.length });
    res.end(file);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  assert.equal(tmpDirsBefore(), leftoverBefore, "aucun dossier temporaire ne doit rester");
});

async function reason(path: string, options?: { maxBytes?: number }): Promise<string> {
  try {
    await probeAudioUrl(base + path, options);
  } catch (err) {
    assert.ok(err instanceof AudioProbeError, `erreur inattendue : ${err}`);
    return err.reason;
  }
  assert.fail("le fichier aurait dû être refusé");
}

describe("probeAudioUrl", () => {
  it("mesure un WAV : format, durée, débit, taille réelle, empreinte", async () => {
    const buffer = wav(3);
    files.set("/a", buffer);
    const probe = await probeAudioUrl(base + "/a");
    assert.equal(probe.format, "wav");
    assert.equal(probe.durationSeconds, 3);
    assert.equal(probe.bitrateKbps, 128);
    assert.equal(probe.sizeBytes, buffer.length);
    assert.equal(probe.sha256, createHash("sha256").update(buffer).digest("hex"));
  });

  it("détecte le format d'après le contenu, pas d'après le nom", async () => {
    files.set("/faux.mp3", wav(2));
    const probe = await probeAudioUrl(base + "/faux.mp3");
    assert.equal(probe.format, "wav");
    assert.equal(probe.durationSeconds, 2);
  });

  it("mesure un MP3 sans en-tête de durée en parcourant les trames", async () => {
    files.set("/m", mp3(1000)); // 1000 × 1152 / 44100 ≈ 26,1 s
    const probe = await probeAudioUrl(base + "/m");
    assert.equal(probe.format, "mp3");
    assert.equal(probe.durationSeconds, 26);
  });

  it("refuse un texte, des octets aléatoires et un fichier vide", async () => {
    files.set("/texte", Buffer.from("ceci n'est pas de l'audio"));
    files.set("/alea", Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919) % 251)));
    files.set("/vide", Buffer.alloc(0));
    assert.equal(await reason("/texte"), "not_audio");
    assert.equal(await reason("/alea"), "not_audio");
    assert.equal(await reason("/vide"), "not_audio");
  });

  it("refuse un fichier trop court (moins d'une seconde)", async () => {
    files.set("/court", wav(0.5));
    assert.equal(await reason("/court"), "no_duration");
  });

  it("signale un objet inexistant", async () => {
    assert.equal(await reason("/n-existe-pas"), "not_found");
  });

  it("refuse un fichier au-delà de la taille maximale, sans le télécharger en entier", async () => {
    files.set("/gros", wav(3));
    assert.equal(await reason("/gros", { maxBytes: 1000 }), "too_large");
  });

  it("signale un stockage injoignable", async () => {
    try {
      await probeAudioUrl("http://127.0.0.1:1/x");
      assert.fail("aurait dû échouer");
    } catch (err) {
      assert.ok(err instanceof AudioProbeError);
      assert.equal(err.reason, "unreachable");
    }
  });
});

describe("classifyAudio", () => {
  const cases: Array<[string, Parameters<typeof classifyAudio>[0], string | null]> = [
    ["MP3 Layer 3", { container: "MPEG", codec: "MPEG 1 Layer 3" }, "mp3"],
    ["MPEG Layer 2", { container: "MPEG", codec: "MPEG 2 Layer 2" }, null],
    ["FLAC", { container: "FLAC", codec: "FLAC" }, "flac"],
    ["WAV PCM 16 bits", { container: "WAVE", codec: "PCM", bitsPerSample: 16 }, "wav"],
    ["WAV flottant 32 bits", { container: "WAVE", codec: "IEEE_FLOAT", bitsPerSample: 32 }, "wav"],
    ["WAV 24 bits (extensible)", { container: "WAVE", codec: "non-PCM (65534)", bitsPerSample: 24 }, "wav"],
    ["WAV 32 bits (extensible)", { container: "WAVE", codec: "non-PCM (65534)", bitsPerSample: 32 }, "wav"],
    ["WAV extensible 8 bits", { container: "WAVE", codec: "non-PCM (65534)", bitsPerSample: 8 }, null],
    ["WAV ADPCM", { container: "WAVE", codec: "ADPCM", bitsPerSample: 4 }, null],
    ["WAV A-law", { container: "WAVE", codec: "ALAW", bitsPerSample: 8 }, null],
    ["Ogg Opus", { container: "Ogg", codec: "Opus" }, "ogg"],
    ["Ogg Vorbis", { container: "Ogg", codec: "Vorbis I" }, "ogg"],
    ["M4A AAC", { container: "M4A/isom/iso2", codec: "MPEG-4/AAC" }, "m4a"],
    ["M4A ALAC (Safari seulement)", { container: "M4A/isom/iso2", codec: "ALAC" }, null],
    ["MP4 avec image", { container: "isom/iso2/avc1/mp41", codec: "MPEG-4/AAC", hasVideo: true }, null],
    ["AIFF", { container: "AIFF", codec: "PCM" }, null],
    ["inconnu", {}, null],
  ];
  for (const [label, format, expected] of cases) {
    it(`${label} → ${expected ?? "refusé"}`, () => assert.equal(classifyAudio(format), expected));
  }
});
