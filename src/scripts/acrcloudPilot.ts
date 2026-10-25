// Test d'ACRCloud sur VOS morceaux, depuis votre Mac, avant de brancher quoi que ce soit sur Vynl (spec 15.4, R5).
//
//   npm run pilot:acrcloud -- <dossier>                       envoie ~3 extraits de chaque morceau (20 morceaux au plus)
//   npm run pilot:acrcloud -- <dossier> --dry-run             montre ce qui serait envoyé, SANS rien envoyer
//   npm run pilot:acrcloud -- <dossier> --limit 5 --samples 2 moins de morceaux, moins d'extraits
//   npm run pilot:acrcloud -- <dossier> --csv resultats.csv   écrit aussi un tableau
//   npm run pilot:acrcloud -- <dossier> --raw                 affiche la première réponse brute d'ACRCloud
//
// À mettre dans le dossier : des morceaux que vous CONNAISSEZ (un titre du commerce, une reprise, un mashup), et des
// morceaux 100 % IA qui n'imitent rien. Un bon test reconnaît les premiers et laisse passer les seconds ; les scores
// vous diront à partir de quand une reconnaissance mérite d'être relue (réglage ACRCLOUD_WARN_SCORE).
//
// Réglages lus dans le fichier .env de l'API (jamais affichés, jamais écrits dans git) :
//   ACRCLOUD_HOST            l'hôte de votre projet, affiché dans la console ACRCloud
//   ACRCLOUD_ACCESS_KEY      la clé d'accès du projet
//   ACRCLOUD_ACCESS_SECRET   le secret du projet
//
// Ce script n'écrit RIEN dans Vynl et ne lit pas la base : il découpe des extraits de fichiers locaux (ffmpeg) et les envoie
// à ACRCloud. Chaque extrait compte dans le quota de l'essai gratuit : lancez d'abord --dry-run.

import "dotenv/config";
import { readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { acrCloudConfigFrom, identifySample, type IdentifyResult } from "../lib/acrcloud";
import { cutSample, sampleOffsets } from "../lib/audioSamples";
import { mergeMatches } from "../lib/fingerprintScanner";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".aiff", ".aif"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "?";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Une cellule de CSV : entre guillemets si elle contient une virgule, un guillemet ou un saut de ligne.
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

interface FileReport {
  file: string;
  duration: number | null;
  requests: number;
  status: "recognised" | "nothing" | "error";
  bestScore: number | null;
  bestTitle: string;
  bestArtists: string;
  allMatches: string;
  error: string;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: "string", default: "20" },
      samples: { type: "string", default: "3" },
      csv: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      raw: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const folder = positionals[0];
  if (values.help || !folder) {
    console.log(
      "Usage : npm run pilot:acrcloud -- <dossier> [--limit 20] [--samples 3] [--dry-run] [--raw] [--csv résultats.csv] [--yes]\n" +
        "Sans --yes, une pause de 5 secondes laisse le temps d'annuler (Ctrl+C) avant l'envoi."
    );
    return;
  }

  const limit = Number(values.limit);
  const samples = Number(values.samples);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit doit être un entier ≥ 1");
  if (!Number.isInteger(samples) || samples < 1 || samples > 10) throw new Error("--samples doit être un entier entre 1 et 10");

  const config = acrCloudConfigFrom(process.env);
  if (!config && !values["dry-run"]) {
    throw new Error(
      "Réglages ACRCloud manquants dans .env : ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY et ACRCLOUD_ACCESS_SECRET (les valeurs, jamais affichées ici)."
    );
  }

  const names = (await readdir(folder)).filter((name) => AUDIO_EXTENSIONS.has(extname(name).toLowerCase())).sort().slice(0, limit);
  if (names.length === 0) throw new Error(`Aucun fichier audio dans ${folder} (${[...AUDIO_EXTENSIONS].join(" ")}).`);

  // music-metadata est ESM seulement ; l'import dynamique fonctionne depuis ce module CommonJS.
  const { parseFile } = await import("music-metadata");
  const plan: { name: string; path: string; duration: number | null; offsets: number[] }[] = [];
  for (const name of names) {
    const path = join(folder, name);
    let duration: number | null = null;
    try {
      duration = (await parseFile(path, { duration: true })).format.duration ?? null;
    } catch {
      // Durée illisible : un seul extrait, au début ; ffmpeg dira si le fichier est exploitable.
    }
    plan.push({ name, path, duration, offsets: sampleOffsets(duration, samples) });
  }

  const requests = plan.reduce((total, item) => total + item.offsets.length, 0);
  console.log(`${plan.length} morceau(x), ${requests} requête(s) à envoyer${config ? ` à ${config.host}` : ""}.\n`);
  for (const item of plan) {
    console.log(`  ${item.name}  (${formatDuration(item.duration)})  extraits à ${item.offsets.map((o) => `${o}s`).join(", ")}`);
  }
  if (values["dry-run"]) {
    console.log("\nSimulation : rien n'a été envoyé. Relancez sans --dry-run pour interroger ACRCloud.");
    return;
  }

  const ffmpegStatic: string | null = require("ffmpeg-static");
  const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
  if (!ffmpeg) throw new Error("ffmpeg est introuvable (paquet ffmpeg-static, ou variable FFMPEG_PATH).");

  if (!values.yes) {
    console.log("\nEnvoi dans 5 secondes… Ctrl+C pour annuler.");
    await sleep(5000);
  }

  let rawShown = false;
  const reports: FileReport[] = [];
  for (const item of plan) {
    console.log(`\n${item.name}  (${formatDuration(item.duration)})`);
    const perSample: { offset: number; result: IdentifyResult }[] = [];
    let error = "";
    for (const offset of item.offsets) {
      try {
        const sample = await cutSample(ffmpeg, item.path, offset);
        const result = await identifySample(config!, sample, {
          onResponse: (body) => {
            if (values.raw && !rawShown) {
              rawShown = true;
              console.log(`  [réponse brute]\n${JSON.stringify(body, null, 2)}`);
            }
          },
        });
        perSample.push({ offset, result });
      } catch (err) {
        error = describeError(err);
        console.log(`  ✖ extrait à ${offset}s : ${error}`);
        break;
      }
    }

    const merged = mergeMatches(perSample);
    const best = merged[0];
    const status: FileReport["status"] = error ? "error" : best ? "recognised" : "nothing";
    if (!error) {
      if (best) {
        console.log(`  ✔ reconnu : « ${best.title} » — ${best.artists.join(", ") || "artiste inconnu"} (score ${best.score}, entendu à ${best.seenAtSeconds.map((s) => `${s}s`).join(", ")})`);
        for (const other of merged.slice(1, 4)) console.log(`      aussi : « ${other.title} » — ${other.artists.join(", ")} (score ${other.score})`);
      } else {
        console.log("  · rien de reconnu");
      }
    }
    reports.push({
      file: item.name,
      duration: item.duration,
      requests: perSample.length,
      status,
      bestScore: best?.score ?? null,
      bestTitle: best?.title ?? "",
      bestArtists: best?.artists.join(" / ") ?? "",
      allMatches: merged.map((m) => `${m.title} — ${m.artists.join(" / ")} (${m.score})`).join(" ; "),
      error,
    });
  }

  const count = (status: FileReport["status"]) => reports.filter((r) => r.status === status).length;
  console.log(`\nBilan : ${count("recognised")} reconnu(s), ${count("nothing")} sans résultat, ${count("error")} en erreur — ${reports.reduce((t, r) => t + r.requests, 0)} requête(s) envoyée(s).`);
  console.log("Comparez avec ce que vous savez : les morceaux connus doivent être reconnus, vos morceaux 100 % IA ne devraient pas l'être.");

  if (values.csv) {
    const header = ["file", "duration_s", "requests", "status", "best_score", "best_title", "best_artists", "all_matches", "error"];
    const rows = reports.map((r) => [r.file, r.duration === null ? "" : Math.round(r.duration), r.requests, r.status, r.bestScore, r.bestTitle, r.bestArtists, r.allMatches, r.error]);
    await writeFile(values.csv, [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n", "utf8");
    console.log(`Tableau écrit : ${values.csv}`);
  }
  if (count("error") > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nÉchec : ${describeError(err)}`);
    process.exit(1);
  });
}
