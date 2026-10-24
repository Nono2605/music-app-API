// Test de charge : calculs et garde-fous, purs (sans réseau) pour être testables seuls. Le script est dans
// scripts/loadTest.ts.

export interface Sample {
  // Durée de la réponse en millisecondes ; statut HTTP, ou 0 si le réseau a échoué.
  ms: number;
  status: number;
}

// Percentile « au rang le plus proche » d'une liste TRIÉE. p entre 0 et 100.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export interface Summary {
  requests: number;
  errors: number;
  errorRate: number;
  perSecond: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statuses: Record<string, number>;
}

// Une réponse est une erreur si le réseau a échoué (0) ou si le statut n'est pas 2xx.
export function summarize(samples: Sample[], seconds: number): Summary {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  let errors = 0;
  for (const sample of samples) {
    statuses[String(sample.status)] = (statuses[String(sample.status)] ?? 0) + 1;
    if (sample.status < 200 || sample.status >= 300) errors += 1;
  }
  return {
    requests: samples.length,
    errors,
    errorRate: samples.length === 0 ? 0 : errors / samples.length,
    perSecond: seconds > 0 ? samples.length / seconds : 0,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    p99: percentile(times, 99),
    max: times.length === 0 ? 0 : times[times.length - 1],
    statuses,
  };
}

export interface LoadArgs {
  url: string;
  concurrency: number;
  seconds: number;
}

export const MAX_CONCURRENCY = 50;
export const MAX_SECONDS = 120;

// Hôtes de PRODUCTION : on n'y lance rien sans l'avoir demandé en toutes lettres.
const PRODUCTION_HOST = /(^|\.)vynl\.ch$|\.onrender\.com$/i;

// --url=https://… [--concurrency=10] [--seconds=20] [--allow-production]
export function parseLoadArgs(argv: string[]): LoadArgs {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match) values.set(match[1], match[2] ?? "true");
  }

  const raw = values.get("url");
  if (!raw) throw new Error("--url=https://… est obligatoire : aucune cible par défaut.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Adresse illisible : ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("L'adresse doit commencer par http:// ou https://");
  if (PRODUCTION_HOST.test(url.hostname) && values.get("allow-production") !== "true") {
    throw new Error(`${url.hostname} est la production : ajoutez --allow-production si c'est voulu (lecture seule, mais ça la sollicite).`);
  }

  const number = (key: string, fallback: number) => {
    const parsed = Number(values.get(key) ?? fallback);
    if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`--${key} doit être un nombre positif.`);
    return Math.floor(parsed);
  };

  return {
    url: url.origin,
    concurrency: Math.min(number("concurrency", 10), MAX_CONCURRENCY),
    seconds: Math.min(number("seconds", 20), MAX_SECONDS),
  };
}
