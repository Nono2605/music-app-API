// Le travail d'UNE tâche de transcodage : télécharger l'original, en tirer les versions AAC manquantes, les vérifier,
// les déposer sur R2 et les inscrire en base. Pure (tout accès extérieur est injecté) pour être testable sans ffmpeg,
// sans réseau et sans base.
import { join } from "node:path";
import { renditionKey } from "../lib/renditions";
import { BITRATES_KBPS } from "./ffmpeg";

// Une version dont la durée s'écarte de l'original de plus que ça est tronquée ou corrompue : on ne la publie pas.
// (L'AAC ajoute quelques dizaines de millisecondes de remplissage.)
export const DURATION_TOLERANCE_SECONDS = 2;

export interface TranscodeTask {
  jobId: string;
  fileId: string;
  trackId: string;
  storageKey: string;
}

export interface RenditionRow {
  track_id: string;
  source_file_id: string;
  bitrate_kbps: number;
  storage_key: string;
  file_size_bytes: number;
  duration_seconds: number;
}

export interface TranscodeIo {
  /** Les débits déjà prêts pour ce fichier (une tâche reprise après un plantage ne refait pas ce qui existe). */
  existingBitrates(fileId: string): Promise<number[]>;
  makeWorkDir(): Promise<{ dir: string; cleanup(): Promise<void> }>;
  /** Télécharge l'original (stockage Supabase) vers `dest`. */
  download(storageKey: string, dest: string): Promise<void>;
  /** Durée mesurée sur le fichier, en secondes. */
  probeDuration(path: string): Promise<number>;
  encode(input: string, output: string, bitrateKbps: number): Promise<void>;
  fileSize(path: string): Promise<number>;
  upload(key: string, path: string, sizeBytes: number): Promise<void>;
  removeUploaded(key: string): Promise<void>;
  /** Inscrit la version ; sans erreur si elle existe déjà (deux workers sur la même tâche). */
  saveRendition(row: RenditionRow): Promise<void>;
}

export interface TranscodeResult {
  produced: number[];
  alreadyThere: number[];
}

export async function processTask(io: TranscodeIo, task: TranscodeTask, bitrates: readonly number[] = BITRATES_KBPS): Promise<TranscodeResult> {
  const have = new Set(await io.existingBitrates(task.fileId));
  const todo = bitrates.filter((kbps) => !have.has(kbps));
  const alreadyThere = bitrates.filter((kbps) => have.has(kbps));
  if (todo.length === 0) return { produced: [], alreadyThere };

  const work = await io.makeWorkDir();
  const produced: number[] = [];
  try {
    const source = join(work.dir, "source");
    await io.download(task.storageKey, source);
    const sourceSeconds = await io.probeDuration(source);

    for (const kbps of todo) {
      const output = join(work.dir, `out-${kbps}.m4a`);
      await io.encode(source, output, kbps);

      const outSeconds = await io.probeDuration(output);
      if (!Number.isFinite(outSeconds) || Math.abs(outSeconds - sourceSeconds) > DURATION_TOLERANCE_SECONDS) {
        throw new Error(`La version ${kbps} kbit/s dure ${outSeconds.toFixed(1)} s pour ${sourceSeconds.toFixed(1)} s à l'origine : refusée`);
      }

      const size = await io.fileSize(output);
      if (size <= 0) throw new Error(`La version ${kbps} kbit/s est vide`);

      const key = renditionKey(task.trackId, task.fileId, kbps);
      await io.upload(key, output, size);
      try {
        await io.saveRendition({
          track_id: task.trackId,
          source_file_id: task.fileId,
          bitrate_kbps: kbps,
          storage_key: key,
          file_size_bytes: size,
          duration_seconds: Math.max(1, Math.round(outSeconds)),
        });
      } catch (err) {
        // Inscription refusée (fichier supprimé entre-temps, base en panne) : on ne laisse pas de fichier orphelin sur R2.
        await io.removeUploaded(key).catch(() => {});
        throw err;
      }
      produced.push(kbps);
    }
  } finally {
    await work.cleanup();
  }
  return { produced, alreadyThere };
}

// La file de suppression des fichiers du CDN (cdn_object_deletions) : une clé n'est retirée de la file qu'une fois le
// fichier supprimé de R2 (supprimer un fichier absent n'est pas une erreur).
export interface DeletionIo {
  list(limit: number): Promise<{ id: number; storage_key: string; attempts: number }[]>;
  deleteObject(key: string): Promise<void>;
  remove(id: number): Promise<void>;
  markFailed(id: number, message: string, attempts: number): Promise<void>;
}

export async function drainDeletions(io: DeletionIo, limit = 50): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const item of await io.list(limit)) {
    try {
      await io.deleteObject(item.storage_key);
      await io.remove(item.id);
      deleted += 1;
    } catch (err) {
      failed += 1;
      await io.markFailed(item.id, err instanceof Error ? err.message : String(err), item.attempts + 1).catch(() => {});
    }
  }
  return { deleted, failed };
}

// Attente avant le nouvel essai d'une tâche qui vient d'échouer : 5 min, puis 10 min.
export function retryDelaySeconds(attempts: number): number {
  return 300 * Math.max(1, attempts);
}
