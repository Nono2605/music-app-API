// Rattrapage : mesure les fichiers audio uploadés AVANT la mesure automatique
// (format « unknown », taille déclarée par le navigateur, aucune durée).
//
//   npm run backfill:audio                       simulation : mesure tout, n'écrit RIEN
//   npm run backfill:audio -- --apply            écrit les mesures
//   npm run backfill:audio -- --track <uuid>     un seul morceau (pour un premier essai)
//   npm run backfill:audio -- --limit 5          les 5 premiers fichiers seulement
//
// Ce que fait --apply, pour chaque fichier jamais mesuré (verified_at est null) :
//   - renseigne format, taille, débit, empreinte SHA-256, durée et verified_at
//     d'après le fichier lui-même ;
//   - aligne ensuite tracks.duration_seconds sur le fichier le plus ancien du
//     morceau (celui qui est streamé).
//
// Garde-fous : ne SUPPRIME jamais rien (un fichier illisible est signalé, pas
// retiré du stockage ni de la base) ; ne touche que les lignes jamais mesurées ;
// rejouable ; un fichier en échec n'arrête pas les autres.
//
// Utilise la clé secrète de .env : il agit sur la base RÉELLE. Lancez toujours la
// simulation d'abord. Chaque fichier non mesuré est téléchargé une fois depuis le
// stockage (consomme de la bande passante sortante).
//
// Prérequis : la migration 20261009000000_integrity_guards.sql (colonnes
// track_files.duration_seconds et verified_at).

import { parseArgs } from "node:util";
import { env } from "../config/env";
import { supabaseAdmin } from "../lib/supabaseAdmin";
import { probeAudioUrl, AudioProbeError, type AudioProbe } from "../lib/audioProbe";
import { pickTrackDuration } from "../lib/trackDuration";
import { syncTrackDuration } from "../lib/syncTrackDuration";

const AUDIO_BUCKET = "track-audio";
const PAGE_SIZE = 500;
const SIGNED_URL_SECONDS = 600;
const MAX_ATTEMPTS = 3;

interface Candidate {
  id: string;
  track_id: string;
  storage_provider: string;
  storage_key: string;
  format: string;
  file_size_bytes: number | null;
  created_at: string;
}

export interface BackfillOptions {
  apply: boolean;
  trackId?: string;
  limit?: number;
}

export interface BackfillSummary {
  candidates: number;
  measured: number;
  written: number;
  skipped: number;
  failures: Record<string, number>;
  tracksChanged: number;
  tracksUnchanged: number;
  largeDiscrepancies: number;
}

type Log = (line: string) => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mmss = (seconds: number | null) =>
  seconds === null ? "—" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const mo = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`;
const short = (id: string) => id.slice(0, 8);

// Les colonnes viennent de la migration : sans elle, tout échouerait fichier par
// fichier avec un message obscur. On préfère s'arrêter tout de suite et clairement.
async function assertMigrationApplied() {
  const { error } = await supabaseAdmin.from("track_files").select("duration_seconds, verified_at").limit(1);
  if (!error) return;
  if (/fetch failed/i.test(error.message)) {
    throw new Error(
      `Impossible de joindre Supabase (${new URL(env.supabaseUrl).host}) : vérifiez SUPABASE_URL dans .env et votre connexion.`
    );
  }
  if (error.code === "42703" || /duration_seconds|verified_at/.test(error.message)) {
    throw new Error(
      "Les colonnes track_files.duration_seconds et verified_at n'existent pas : " +
        "appliquez d'abord la migration 20261009000000_integrity_guards.sql."
    );
  }
  throw error;
}

// Toute la liste est lue AVANT de commencer à écrire : écrire verified_at retire
// des lignes du filtre, ce qui ferait sauter des fichiers en paginant en cours de route.
async function listCandidates(options: BackfillOptions): Promise<Candidate[]> {
  const rows: Candidate[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabaseAdmin
      .from("track_files")
      .select("id, track_id, storage_provider, storage_key, format, file_size_bytes, created_at")
      .is("verified_at", null);
    if (options.trackId) query = query.eq("track_id", options.trackId);
    const { data, error } = await query
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE_SIZE) break;
  }
  return options.limit ? rows.slice(0, options.limit) : rows;
}

type Measure = { ok: true; probe: AudioProbe } | { ok: false; reason: string; message: string };

async function measure(file: Candidate): Promise<Measure> {
  const { data, error } = await supabaseAdmin.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(file.storage_key, SIGNED_URL_SECONDS);
  if (error || !data) return { ok: false, reason: "missing", message: "objet introuvable dans le stockage" };

  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, probe: await probeAudioUrl(data.signedUrl) };
    } catch (err) {
      if (err instanceof AudioProbeError) {
        // Un échec réseau passager se retente ; le reste (fichier illisible…) non.
        if (err.reason === "unreachable" && attempt < MAX_ATTEMPTS) {
          await sleep(1000 * attempt);
          continue;
        }
        return { ok: false, reason: err.reason, message: err.message };
      }
      return { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }
}

export async function backfillAudio(options: BackfillOptions, log: Log = console.log): Promise<BackfillSummary> {
  await assertMigrationApplied();

  const candidates = await listCandidates(options);
  const summary: BackfillSummary = {
    candidates: candidates.length,
    measured: 0,
    written: 0,
    skipped: 0,
    failures: {},
    tracksChanged: 0,
    tracksUnchanged: 0,
    largeDiscrepancies: 0,
  };
  log(`${candidates.length} fichier(s) jamais mesuré(s)${options.trackId ? ` pour le morceau ${options.trackId}` : ""}.\n`);

  const trackInfo = new Map<string, { title: string; status: string; duration_seconds: number | null }>();
  async function track(trackId: string) {
    if (!trackInfo.has(trackId)) {
      const { data, error } = await supabaseAdmin
        .from("tracks")
        .select("id, title, status, duration_seconds")
        .eq("id", trackId)
        .maybeSingle();
      if (error) throw error;
      trackInfo.set(trackId, data ?? { title: "(morceau introuvable)", status: "?", duration_seconds: null });
    }
    return trackInfo.get(trackId)!;
  }

  const measured = new Map<string, AudioProbe>(); // id du fichier → mesure
  const touchedTracks = new Set<string>();

  for (const file of candidates) {
    const t = await track(file.track_id);
    const label = `${t.title} [${short(file.track_id)}] fichier ${short(file.id)}`;

    if (file.storage_provider !== "supabase") {
      summary.skipped++;
      log(`– ${label} : ignoré (stockage « ${file.storage_provider} », seul Supabase est géré)`);
      continue;
    }

    const result = await measure(file);
    if (!result.ok) {
      summary.failures[result.reason] = (summary.failures[result.reason] ?? 0) + 1;
      log(`✗ ${label} : ${result.reason} — ${result.message}`);
      continue;
    }

    const { probe } = result;
    summary.measured++;
    measured.set(file.id, probe);
    touchedTracks.add(file.track_id);
    log(
      `✓ ${label} : ${probe.format}, ${mmss(probe.durationSeconds)} (${probe.durationSeconds} s), ` +
        `${probe.bitrateKbps ?? "?"} kbps, ${mo(probe.sizeBytes)}` +
        (file.format !== probe.format ? `  [format déclaré « ${file.format} » → ${probe.format}]` : "")
    );

    if (options.apply) {
      // `verified_at is null` : si ce fichier a été mesuré entre-temps (un upload
      // concurrent), on n'écrase pas.
      const { data: updated, error } = await supabaseAdmin
        .from("track_files")
        .update({
          format: probe.format,
          file_size_bytes: probe.sizeBytes,
          bitrate_kbps: probe.bitrateKbps,
          checksum: probe.sha256,
          duration_seconds: probe.durationSeconds,
          verified_at: new Date().toISOString(),
        })
        .eq("id", file.id)
        .is("verified_at", null)
        .select("id");
      if (error) throw error; // erreur de base inattendue : on arrête plutôt que de continuer à l'aveugle
      summary.written += (updated ?? []).length;
    }
  }

  // Durée de chaque morceau touché : celle de son fichier le plus ancien.
  if (touchedTracks.size > 0) log("\n--- Durée des morceaux ---");
  for (const trackId of touchedTracks) {
    const t = await track(trackId);
    const { data: files, error } = await supabaseAdmin
      .from("track_files")
      .select("id, created_at, duration_seconds")
      .eq("track_id", trackId);
    if (error) throw error;

    // En simulation, la base n'a pas été modifiée : on superpose les mesures.
    const expected = pickTrackDuration(
      (files ?? []).map((f) => ({
        created_at: f.created_at,
        duration_seconds: measured.get(f.id)?.durationSeconds ?? f.duration_seconds,
      }))
    );
    const label = `${t.title} [${short(trackId)}] (${t.status})`;

    if (expected === undefined) {
      summary.tracksUnchanged++;
      log(`= ${label} : durée inchangée (${mmss(t.duration_seconds)}) — le fichier le plus ancien n'a pas pu être mesuré`);
    } else if (expected === t.duration_seconds) {
      summary.tracksUnchanged++;
      log(`= ${label} : durée déjà correcte (${mmss(expected)})`);
    } else {
      summary.tracksChanged++;
      const big =
        t.duration_seconds !== null &&
        expected !== null &&
        Math.abs(expected - t.duration_seconds) > Math.max(2, t.duration_seconds * 0.05);
      if (big) summary.largeDiscrepancies++;
      log(
        `${options.apply ? "→" : "~"} ${label} : durée ${mmss(t.duration_seconds)} → ${mmss(expected)}` +
          (big ? "  ⚠ écart important avec la durée enregistrée" : "")
      );
      if (options.apply) await syncTrackDuration(trackId);
    }
  }

  const failed = Object.values(summary.failures).reduce((a, b) => a + b, 0);
  log("\n=== Résumé ===");
  log(`Fichiers examinés        : ${summary.candidates}`);
  log(`Mesurés                  : ${summary.measured}${options.apply ? ` (écrits en base : ${summary.written})` : " (simulation : rien n'est écrit)"}`);
  log(`En échec                 : ${failed}${failed ? "  " + JSON.stringify(summary.failures) : ""}`);
  if (summary.skipped) log(`Ignorés                  : ${summary.skipped}`);
  log(`Durées de morceaux       : ${summary.tracksChanged} à modifier, ${summary.tracksUnchanged} inchangée(s)`);
  if (summary.largeDiscrepancies) {
    log(`⚠ ${summary.largeDiscrepancies} morceau(x) avec un écart important entre la durée enregistrée et la durée mesurée : à vérifier.`);
  }
  if (failed) log("Les fichiers en échec n'ont PAS été modifiés ni supprimés : à corriger ou à renvoyer par l'artiste.");
  if (!options.apply && summary.measured > 0) log("\nRelancez avec --apply pour écrire ces mesures.");
  return summary;
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      track: { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("Usage : npm run backfill:audio -- [--apply] [--track <uuid>] [--limit <n>]\nSans --apply : simulation, rien n'est écrit.");
    return;
  }

  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit doit être un entier ≥ 1");

  const host = new URL(env.supabaseUrl).host;
  console.log(`Base visée : ${host}`);
  console.log(values.apply ? "Mode : ÉCRITURE\n" : "Mode : SIMULATION (aucune écriture)\n");
  if (values.apply) {
    console.log("Écriture dans 5 secondes… Ctrl+C pour annuler.");
    await sleep(5000);
  }

  const summary = await backfillAudio({ apply: values.apply, trackId: values.track, limit });
  const failed = Object.values(summary.failures).reduce((a, b) => a + b, 0);
  if (failed > 0) process.exitCode = 1;
}

// Les erreurs de supabase-js ne sont pas des instances d'Error : ce sont des
// objets { message, code, details, hint } (voir errorHandler.ts).
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const { message, code } = err as { message: unknown; code?: unknown };
    return `${String(message)}${code ? ` (code ${String(code)})` : ""}`;
  }
  return String(err);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nÉchec : ${describeError(err)}`);
    process.exit(1);
  });
}
