// Mise en forme des résultats des fonctions SQL creator_stats_* (migration
// 20261010000000_creator_stats.sql). Fonctions pures, sans accès base.

// PostgREST renvoie un `numeric` tantôt en nombre, tantôt en texte selon le
// contexte : on garantit un nombre fini, et 0 à défaut.
export function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export interface Totals {
  plays: number;
  starts: number;
  listeners: number;
  seconds: number;
  saves: number;
  new_followers: number;
}

export function shapeTotals(row: Record<string, unknown> | undefined): Totals {
  return {
    plays: toNumber(row?.plays),
    starts: toNumber(row?.starts),
    listeners: toNumber(row?.listeners),
    seconds: toNumber(row?.seconds),
    saves: toNumber(row?.saves),
    new_followers: toNumber(row?.new_followers),
  };
}

export interface DailyPoint {
  day: string;
  plays: number;
  listeners: number;
  seconds: number;
}

export function shapeDaily(rows: Record<string, unknown>[]): DailyPoint[] {
  return rows.map((r) => ({
    day: String(r.day),
    plays: toNumber(r.plays),
    listeners: toNumber(r.listeners),
    seconds: toNumber(r.seconds),
  }));
}

export interface BreakdownRow {
  key: string;
  plays: number;
  seconds: number;
}

// Garde les `limit` premières clés connues (les plus écoutées), regroupe le reste
// sous « other », et laisse « unknown » (lectures sans l'information) à part, en
// dernier : sa part dit à quel point la répartition est fiable. Le client n'a
// ainsi jamais plus de limit + 2 lignes à afficher.
export function foldBreakdown(rows: BreakdownRow[], limit: number): BreakdownRow[] {
  const known = rows
    .filter((r) => r.key !== "unknown")
    .sort((a, b) => b.plays - a.plays || a.key.localeCompare(b.key));
  const unknown = rows.find((r) => r.key === "unknown");

  const out = known.slice(0, limit);
  const tail = known.slice(limit);
  if (tail.length > 0) {
    out.push({
      key: "other",
      plays: tail.reduce((sum, r) => sum + r.plays, 0),
      seconds: tail.reduce((sum, r) => sum + r.seconds, 0),
    });
  }
  if (unknown) out.push(unknown);
  return out;
}

export interface Breakdown {
  source: BreakdownRow[];
  country: BreakdownRow[];
  device: BreakdownRow[];
}

const BREAKDOWN_LIMIT = 8;

export function shapeBreakdown(rows: Record<string, unknown>[]): Breakdown {
  const by: Record<keyof Breakdown, BreakdownRow[]> = { source: [], country: [], device: [] };
  for (const r of rows) {
    const dimension = String(r.dimension);
    if (dimension !== "source" && dimension !== "country" && dimension !== "device") continue;
    by[dimension].push({ key: String(r.key), plays: toNumber(r.plays), seconds: toNumber(r.seconds) });
  }
  return {
    source: foldBreakdown(by.source, BREAKDOWN_LIMIT),
    country: foldBreakdown(by.country, BREAKDOWN_LIMIT),
    device: foldBreakdown(by.device, BREAKDOWN_LIMIT),
  };
}

export interface TopTrack {
  track_id: string;
  title: string;
  plays: number;
  listeners: number;
  seconds: number;
}

export function shapeTopTracks(rows: Record<string, unknown>[]): TopTrack[] {
  return rows.map((r) => ({
    track_id: String(r.track_id),
    title: String(r.title),
    plays: toNumber(r.plays),
    listeners: toNumber(r.listeners),
    seconds: toNumber(r.seconds),
  }));
}
