// Les EXTRAITS audio envoyés à un prestataire de reconnaissance : quelques tranches d'une douzaine de secondes, réparties
// dans le morceau (un mashup ou un sample se trahit à un endroit précis, pas forcément au début). ffmpeg (le même que
// celui du transcodage, paquet ffmpeg-static) découpe directement depuis le fichier ou son adresse signée : un
// morceau n'est jamais téléchargé en entier pour ça.

import { spawn } from "node:child_process";

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

// mp3 mono 16 kHz à 64 kbit/s : une douzaine de secondes pèsent une centaine de kilo-octets (la limite d'ACRCloud est de 5 Mo).
//   -ss avant -i : se place directement dans le fichier (requête partielle sur une adresse HTTP)
//   -vn -map_metadata -1 : ni image de pochette, ni étiquettes
export function buildSampleArgs(input: string, startSeconds: number, seconds: number = SAMPLE_SECONDS): string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-ss", String(Math.max(0, startSeconds)), "-t", String(seconds),
    "-i", input,
    "-vn", "-map_metadata", "-1",
    "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k",
    "-f", "mp3", "pipe:1",
  ];
}

const STDERR_KEPT = 500;

// Découpe un extrait et le rend en mémoire. Erreur avec la fin de ce que ffmpeg a écrit s'il échoue ; tué au bout de
// `timeoutMs`.
export function cutSample(
  ffmpegBinary: string,
  input: string,
  startSeconds: number,
  seconds: number = SAMPLE_SECONDS,
  timeoutMs = 60_000
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary, buildSampleArgs(input, startSeconds, seconds), { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
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
    child.on("close", (code) => {
      clearTimeout(timer);
      const sample = Buffer.concat(chunks);
      // L'adresse d'entrée (signée, donc secrète un quart d'heure) peut figurer dans les messages de ffmpeg : on l'efface.
      const detail = stderr.replace(/https?:\/\/\S+/g, "<address>").trim();
      if (code === 0 && sample.length > 0) resolve(sample);
      else reject(new Error(`ffmpeg failed (code ${code}): ${detail || "no sample produced"}`));
    });
  });
}
