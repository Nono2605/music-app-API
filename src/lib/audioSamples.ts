// Les EXTRAITS audio envoyés à un prestataire de reconnaissance : quelques tranches d'une douzaine de secondes, réparties
// dans le morceau (un mashup ou un sample se trahit à un endroit précis, pas forcément au début). ffmpeg (le même que
// celui du transcodage, paquet ffmpeg-static) découpe dans un fichier LOCAL (voir lib/tempDownload.ts) et écrit un petit
// WAV : aucun encodeur à installer, rien à lire sur le réseau.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ACRCloud conseille moins de 15 secondes par extrait.
export const SAMPLE_SECONDS = 12;
export const DEFAULT_SAMPLE_COUNT = 3;

// Les débuts d'extraits, en secondes, répartis régulièrement ; le premier n'est jamais le tout début (introduction) ni
// le dernier la toute fin (silence). Un morceau trop court pour contenir tous les extraits en reçoit moins ; sans durée
// connue, un seul extrait au début.
export function sampleOffsets(durationSeconds: number | null, count: number = DEFAULT_SAMPLE_COUNT, seconds: number = SAMPLE_SECONDS): number[] {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= seconds) return [0];
  const wanted = Math.max(1, Math.min(count, Math.floor(durationSeconds / seconds)));
  const starts: number[] = [];
  for (let i = 1; i <= wanted; i++) {
    const center = (durationSeconds * i) / (wanted + 1);
    const start = Math.min(Math.max(0, center - seconds / 2), durationSeconds - seconds);
    starts.push(Math.round(start));
  }
  return [...new Set(starts)];
}

// WAV (PCM 16 bits) mono 16 kHz : une douzaine de secondes pèsent environ 400 Ko (la limite d'ACRCloud est de 5 Mo).
//   -ss avant -i : se place directement dans le fichier local
//   -vn -map_metadata -1 : ni image de pochette, ni étiquettes
//   sortie dans un FICHIER (un WAV écrit dans un tube n'a pas de taille dans son en-tête)
export function buildSampleArgs(input: string, startSeconds: number, seconds: number, output: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-ss", String(Math.max(0, startSeconds)), "-t", String(seconds),
    "-i", input,
    "-vn", "-map_metadata", "-1",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    "-f", "wav", "-y", output,
  ];
}

const STDERR_KEPT = 500;

// Pourquoi ffmpeg s'est arrêté : « code 1 » (il a refusé) ou « killed by SIGKILL » (le système l'a arrêté, souvent faute de
// mémoire ; SIGSEGV et SIGILL : le programme lui-même a planté).
function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (!signal) return `code ${code}`;
  if (signal === "SIGKILL") return `killed by SIGKILL, often out of memory`;
  if (signal === "SIGSEGV" || signal === "SIGILL" || signal === "SIGBUS") return `crashed with ${signal}`;
  return `killed by ${signal}`;
}

// Découpe un extrait d'un fichier LOCAL et le rend en mémoire (WAV). Erreur avec la fin de ce que ffmpeg a écrit s'il échoue ;
// tué au bout de `timeoutMs`. Le dossier temporaire est toujours supprimé.
export async function cutSample(
  ffmpegBinary: string,
  inputPath: string,
  startSeconds: number,
  seconds: number = SAMPLE_SECONDS,
  timeoutMs = 60_000
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vynl-sample-"));
  const output = join(dir, "sample.wav");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegBinary, buildSampleArgs(inputPath, startSeconds, seconds, output), { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`ffmpeg stopped after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`ffmpeg does not start: ${err.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        // Une adresse (signée, donc secrète un quart d'heure) peut figurer dans les messages de ffmpeg : on l'efface.
        const detail = stderr.replace(/https?:\/\/\S+/g, "<address>").trim();
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg failed (${describeExit(code, signal)}): ${detail || "no message"}`));
      });
    });
    const sample = await readFile(output);
    if (sample.length === 0) throw new Error("ffmpeg failed (code 0): no sample produced");
    return sample;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
