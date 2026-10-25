// Télécharge un fichier (typiquement une adresse signée vers le stockage) dans un dossier temporaire, en flux : le
// fichier entier n'est jamais en mémoire. Même principe que lib/audioProbe.ts et que le worker de transcodage : ffmpeg
// travaille sur un fichier LOCAL, pas sur une adresse HTTPS (les versions « statiques » de ffmpeg résolvent mal les noms de
// domaine et plantent sans message dans certains environnements, et chaque extrait rouvrirait la connexion).
//
// Celui qui reçoit le résultat DOIT appeler cleanup() (le dossier est supprimé) ; en cas d'erreur, tout est nettoyé ici.

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_AUDIO_BYTES } from "./audioProbe";

export interface TempFile {
  path: string;
  cleanup(): Promise<void>;
}

export interface DownloadOptions {
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export async function downloadToTempFile(url: string, options: DownloadOptions = {}): Promise<TempFile> {
  const maxBytes = options.maxBytes ?? MAX_AUDIO_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (err) {
    // Le message de fetch ne contient pas l'adresse ; on n'ajoute pas non plus la nôtre (elle est signée).
    throw new Error(`audio download failed: ${err instanceof Error ? err.message : "network error"}`);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`audio download failed (HTTP ${response.status})`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error("audio file larger than the maximum size");
  }

  const dir = await mkdtemp(join(tmpdir(), "vynl-fingerprint-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  // Nom neutre, sans extension : ffmpeg reconnaît le format d'après le contenu.
  const path = join(dir, "audio");

  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new Error("audio file larger than the maximum size"));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path));
    if (bytes === 0) throw new Error("audio file is empty");
  } catch (err) {
    await cleanup();
    throw err instanceof Error && /larger|empty/.test(err.message) ? err : new Error(`audio download failed: ${err instanceof Error ? err.message : "stream error"}`);
  }
  return { path, cleanup };
}
