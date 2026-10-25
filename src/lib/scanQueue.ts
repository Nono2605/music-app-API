import { hostname } from "node:os";
import type { BlockedDb } from "./blockedFiles";
import type { DuplicateDb } from "./duplicateFile";
import { createScanRunner, type ScanJob, type ScanRunnerDeps } from "./scanRunner";
import { blockedAudioScanner, duplicateAudioScanner, similarTitleScanner, type ScanContext } from "./scanners";
import type { ScanRecord } from "./scanLog";
import { isMissingFunction, isMissingTable } from "./schemaCompat";
import type { TitleDb } from "./similarTitle";
import { supabaseAdmin } from "./supabaseAdmin";

// La file des contrôles côté API : mettre un morceau en file, et l'exécuteur réel (voir scanRunner.ts pour les règles).
// La file n'existe qu'après la migration 20261026000000 : sans elle, rien n'est lancé et rien ne casse.

export type ScanReason = "submit" | "manual" | "periodic";

const LEASE_SECONDS = 300;
const MAX_ATTEMPTS = 3;

// Juste ce qu'il faut du client Supabase, pour pouvoir le remplacer dans les tests.
export interface RpcDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

let queueMissingLogged = false;
function noteQueueMissing(): void {
  if (queueMissingLogged) return;
  queueMissingLogged = true;
  console.warn("Scan queue is not set up yet: apply migration 20261026000000_scan_jobs.sql. No automatic check will run.");
}

// Met des morceaux en file « au mieux » : un contrôle ne doit jamais empêcher le travail d'un artiste, ni faire échouer
// sa demande. Rend le nombre de tâches créées (un morceau déjà en file n'en crée pas de seconde).
export async function enqueueTrackScans(
  trackIds: string[],
  reason: ScanReason,
  db: RpcDb = supabaseAdmin as unknown as RpcDb
): Promise<number> {
  let queued = 0;
  for (const trackId of new Set(trackIds)) {
    try {
      const { data, error } = await db.rpc("enqueue_track_scans", { p_track: trackId, p_reason: reason });
      if (error) {
        if (isMissingFunction(error) || isMissingTable(error)) {
          noteQueueMissing();
          return queued;
        }
        console.error("Could not queue the checks:", (error as { message?: string }).message ?? error);
        continue;
      }
      if (data) queued++;
    } catch (err) {
      console.error("Could not queue the checks:", (err as { message?: string })?.message ?? err);
    }
  }
  return queued;
}

const workerId = `${hostname()}-${process.pid}`;

const realDeps: ScanRunnerDeps = {
  scanners: [
    duplicateAudioScanner(supabaseAdmin as unknown as DuplicateDb),
    blockedAudioScanner(supabaseAdmin as unknown as BlockedDb),
    similarTitleScanner(supabaseAdmin as unknown as TitleDb),
  ],

  async claim(): Promise<ScanJob | null> {
    const { data, error } = await supabaseAdmin.rpc("claim_scan_job", {
      p_worker: workerId,
      p_lease_seconds: LEASE_SECONDS,
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (error) {
      if (isMissingFunction(error) || isMissingTable(error)) {
        noteQueueMissing();
        return null;
      }
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return { jobId: row.job_id, trackId: row.track_id, reason: row.reason, attempts: row.attempts };
  },

  async loadContext(trackId): Promise<ScanContext | null> {
    const track = await supabaseAdmin
      .from("tracks")
      .select("id, title, duration_seconds, artist_id")
      .eq("id", trackId)
      .maybeSingle();
    if (track.error) throw track.error;
    if (!track.data) return null;

    const files = await supabaseAdmin
      .from("track_files")
      .select("id, checksum, storage_key")
      .eq("track_id", trackId)
      .is("purged_at", null);
    if (files.error) throw files.error;

    return { track: track.data, files: files.data ?? [] };
  },

  async record(records: ScanRecord[]): Promise<void> {
    if (records.length === 0) return;
    const { error } = await supabaseAdmin.from("track_scans").insert(records);
    if (error) throw error;
  },

  async finish(job) {
    const { error } = await supabaseAdmin.rpc("finish_scan_job", { p_job: job.jobId, p_worker: workerId });
    if (error) throw error;
  },

  async fail(job, message) {
    const { error } = await supabaseAdmin.rpc("fail_scan_job", {
      p_job: job.jobId,
      p_worker: workerId,
      p_error: message,
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (error) throw error;
  },

  log: (message) => console.error(`[scans] ${message}`),
};

// L'exécuteur de ce processus.
export const scanRunner = createScanRunner(realDeps);

// Appelées APRÈS la réponse à l'artiste : elles mettent les morceaux en file puis réveillent l'exécuteur (même si la
// tâche existait déjà : réveiller ne coûte rien). Ne lèvent jamais.
function startScans(load: () => Promise<string[]>, reason: ScanReason): void {
  setImmediate(() => {
    void (async () => {
      await enqueueTrackScans(await load(), reason);
      await scanRunner.kick();
    })().catch((err) => console.error("Could not start the checks:", (err as { message?: string })?.message ?? err));
  });
}

export function queueScansAfterSubmit(trackIds: string[]): void {
  if (trackIds.length > 0) startScans(async () => trackIds, "submit");
}

// Une release envoyée en relecture : tous ses morceaux, tels qu'ils sont au moment où l'exécuteur démarre.
export function queueScansAfterAlbumSubmit(albumId: string): void {
  startScans(async () => {
    const { data, error } = await supabaseAdmin.from("tracks").select("id").eq("album_id", albumId);
    if (error) throw error;
    return (data ?? []).map((track) => track.id);
  }, "submit");
}
