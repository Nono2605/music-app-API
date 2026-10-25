// Worker de transcodage : à lancer comme « Background Worker » sur Render (commande : npm run worker:transcode).
//
// Boucle : vider la file de suppression des fichiers du CDN, prendre la plus ancienne tâche de transcodage, la traiter,
// recommencer ; pause quand il n'y a rien à faire. Plusieurs copies peuvent tourner ensemble (la base ne donne jamais
// la même tâche à deux workers) ; un worker planté perd son bail et sa tâche est reprise (migration 20261025000000).
import { hostname } from "node:os";
import { supabaseAdmin } from "../lib/supabaseAdmin";
import { parseWorkerConfig } from "./config";
import { createIo } from "./io";
import { drainDeletions, processTask, retryDelaySeconds, type TranscodeTask } from "./transcodeJob";

const LEASE_SECONDS = 20 * 60;
const MAX_ATTEMPTS = 3;

const ffmpegStatic: string | null = require("ffmpeg-static");

const parsed = parseWorkerConfig(process.env, ffmpegStatic);
if (!parsed.ok) {
  console.error(`Réglages manquants pour le worker : ${parsed.missing.join(", ")}`);
  process.exit(1);
}
const config = parsed.config;
const io = createIo(config);
const workerId = `${hostname()}-${process.pid}`;

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} reçu : on termine la tâche en cours puis on s'arrête`);
    stopping = true;
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function claim(): Promise<(TranscodeTask & { attempts: number }) | null> {
  const { data, error } = await supabaseAdmin.rpc("claim_transcode_job", {
    p_worker: workerId,
    p_lease_seconds: LEASE_SECONDS,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return { jobId: row.job_id, fileId: row.source_file_id, trackId: row.track_id, storageKey: row.storage_key, attempts: row.attempts };
}

async function handle(task: TranscodeTask & { attempts: number }) {
  const started = Date.now();
  try {
    const result = await processTask(io.transcode, task);
    const { error } = await supabaseAdmin.rpc("finish_transcode_job", { p_job: task.jobId, p_worker: workerId });
    if (error) throw error;
    console.log(
      `fichier ${task.fileId} : versions ${result.produced.join("/") || "aucune nouvelle"} (déjà là : ${result.alreadyThere.join("/") || "aucune"}) en ${Math.round((Date.now() - started) / 1000)} s`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : JSON.stringify(err);
    console.error(`fichier ${task.fileId} : échec (essai ${task.attempts}/${MAX_ATTEMPTS}) : ${message}`);
    const { error } = await supabaseAdmin.rpc("fail_transcode_job", {
      p_job: task.jobId,
      p_worker: workerId,
      p_error: message,
      p_retry_after_seconds: retryDelaySeconds(task.attempts),
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (error) console.error("  impossible d'enregistrer l'échec :", error.message);
  }
}

async function main() {
  console.log(`worker de transcodage ${workerId} démarré (bucket ${config.r2.bucket}, pause ${config.pollSeconds} s)`);
  while (!stopping) {
    let busy = false;
    try {
      const swept = await drainDeletions(io.deletions);
      if (swept.deleted + swept.failed > 0) {
        console.log(`suppressions R2 : ${swept.deleted} faite(s), ${swept.failed} en échec`);
        busy = swept.deleted > 0;
      }
      const task = await claim();
      if (task) {
        await handle(task);
        busy = true;
      }
    } catch (err) {
      console.error("erreur dans la boucle :", err instanceof Error ? err.message : err);
    }
    if (!busy && !stopping) await sleep(config.pollSeconds * 1000);
  }
  console.log("worker arrêté proprement");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
