// L'exécuteur des contrôles : prend les tâches de la file (scan_jobs) une à une, lance chaque contrôle sur le morceau,
// écrit tous les résultats d'un coup dans le journal (track_scans), puis termine la tâche.
//
// Il tourne DANS l'API (l'offre gratuite de Render n'a pas de service d'arrière-plan) : on le « réveille » (kick) à
// l'envoi d'un morceau en relecture, au démarrage de l'API et depuis l'admin. Un seul à la fois par processus.
// Si l'API s'endort en cours de tâche, le bail de la tâche s'achève et la tâche est reprise (voir la migration).
//
// Règles :
//  - un contrôle qui LÈVE une erreur est journalisé « indisponible » (résultat warn, detail.unavailable) : les autres
//    contrôles ne sont pas perdus, et l'admin voit qu'un contrôle n'a pas répondu ;
//  - une panne de l'exécuteur lui-même (lecture du morceau, écriture du journal) fait échouer la tâche, qui sera reprise ;
//  - rien n'est écrit avant que tous les contrôles aient fini : une tâche reprise ne laisse pas de résultats à moitié écrits.

import type { ScanRecord } from "./scanLog";
import type { ScanContext, Scanner } from "./scanners";

export interface ScanJob {
  jobId: string;
  trackId: string;
  reason: string;
  attempts: number;
}

export interface ScanRunnerDeps {
  scanners: Scanner[];
  /** Prend la plus ancienne tâche disponible, ou null. */
  claim(): Promise<ScanJob | null>;
  /** Le morceau et ses fichiers ; null si le morceau a disparu depuis. */
  loadContext(trackId: string): Promise<ScanContext | null>;
  /** Écrit les résultats ; LÈVE si l'écriture échoue. */
  record(records: ScanRecord[]): Promise<void>;
  finish(job: ScanJob): Promise<void>;
  fail(job: ScanJob, message: string): Promise<void>;
  log?: (message: string) => void;
}

export interface RunnerLimits {
  maxJobs: number;
  maxMillis: number;
}

const DEFAULT_LIMITS: RunnerLimits = { maxJobs: 50, maxMillis: 4 * 60_000 };

// La base rend une tâche échouée après une attente (120 s) : on se réveille un peu après, sinon elle attendrait le
// prochain envoi en relecture.
const RETRY_DELAY_MS = 130_000;

export interface RunnerOptions {
  limits?: RunnerLimits;
  now?: () => number;
  /** Programme un réveil ; remplaçable dans les tests. Le minuteur ne retient pas le processus à l'arrêt. */
  schedule?: (callback: () => void, delayMs: number) => void;
  retryDelayMs?: number;
}

function defaultSchedule(callback: () => void, delayMs: number): void {
  setTimeout(callback, delayMs).unref();
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : JSON.stringify(err);
}

// Traite UNE tâche. Lève si l'exécuteur lui-même a échoué (la tâche doit alors être rendue à la file).
export async function processJob(deps: ScanRunnerDeps, job: ScanJob): Promise<void> {
  const context = await deps.loadContext(job.trackId);
  if (!context) {
    // Le morceau a été supprimé entre-temps : plus rien à contrôler.
    await deps.finish(job);
    return;
  }

  const records: ScanRecord[] = [];
  for (const scanner of deps.scanners) {
    const base = {
      track_id: context.track.id,
      artist_id: context.track.artist_id,
      check_kind: scanner.kind,
      provider: scanner.provider,
      provider_version: scanner.version ?? null,
    };
    const trace = { job_id: job.jobId, reason: job.reason };
    try {
      const outcomes = await scanner.run(context);
      for (const outcome of outcomes) records.push({ ...base, ...outcome, detail: { ...outcome.detail, ...trace } });
    } catch (err) {
      // « Indisponible » n'est jamais « ok » : un avertissement à relire, avec la raison pour les journaux.
      deps.log?.(`contrôle ${scanner.kind} indisponible pour le morceau ${job.trackId} : ${describeError(err)}`);
      records.push({ ...base, result: "warn", detail: { ...trace, unavailable: true, message: describeError(err).slice(0, 200) } });
    }
  }

  await deps.record(records);
  await deps.finish(job);
}

export function createScanRunner(deps: ScanRunnerDeps, options: RunnerOptions = {}) {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  let running: Promise<void> | null = null;
  let again = false;
  let retryPlanned = false;

  function planRetry(): void {
    if (retryPlanned) return;
    retryPlanned = true;
    schedule(() => {
      retryPlanned = false;
      void kick();
    }, retryDelayMs);
  }

  async function drain(): Promise<void> {
    const started = now();
    let handled = 0;
    while (handled < limits.maxJobs && now() - started < limits.maxMillis) {
      let job: ScanJob | null;
      try {
        job = await deps.claim();
      } catch (err) {
        deps.log?.(`file des contrôles illisible : ${describeError(err)}`);
        return;
      }
      if (!job) return;
      handled++;
      try {
        await processJob(deps, job);
      } catch (err) {
        const message = describeError(err);
        deps.log?.(`tâche ${job.jobId} (morceau ${job.trackId}) : échec, essai ${job.attempts} : ${message}`);
        try {
          await deps.fail(job, message);
          planRetry();
        } catch (failErr) {
          deps.log?.(`tâche ${job.jobId} : impossible de la rendre à la file : ${describeError(failErr)}`);
        }
      }
    }
  }

  // Réveille l'exécuteur. S'il tourne déjà, il refera un tour à la fin (une tâche arrivée entre-temps n'est pas oubliée).
  // La promesse rendue ne rejette jamais : les appelants peuvent l'ignorer.
  function kick(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await drain();
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return { kick, isRunning: () => running !== null };
}
