// Fenêtre de dates des statistiques créateur. Fonction pure (l'heure est passée
// en paramètre) pour être testée sans horloge réelle.
//
// Jours en UTC, comme les périodes de la spec. La fenêtre se termine à la fin de
// la journée UTC en cours (borne haute exclue : minuit de demain) : « 30 jours »
// = les 29 jours écoulés + aujourd'hui, jamais 30 jours glissants qui couperaient
// une journée en deux. La période précédente a la même durée, juste avant : c'est
// elle qui sert aux variations « vs la période d'avant ».

export const RANGE_KEYS = ["7d", "30d", "90d"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];
export const DEFAULT_RANGE: RangeKey = "30d";

const DAY_MS = 86_400_000; // pas de changement d'heure en UTC : un jour dure toujours 24 h

export interface StatsRange {
  key: RangeKey;
  days: number;
  /** Début inclus (minuit UTC). */
  from: Date;
  /** Fin exclue (minuit UTC de demain). */
  to: Date;
  previousFrom: Date;
  previousTo: Date;
}

// `raw` vient de la query string : n'importe quoi (absent, tableau, texte).
// Absent -> défaut ; valeur inconnue -> null (l'appelant répond 400).
export function parseStatsRange(raw: unknown, now: Date): StatsRange | null {
  const key = raw === undefined ? DEFAULT_RANGE : raw;
  if (typeof key !== "string" || !(RANGE_KEYS as readonly string[]).includes(key)) return null;

  const days = Number.parseInt(key, 10);
  const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const from = to - days * DAY_MS;

  return {
    key: key as RangeKey,
    days,
    from: new Date(from),
    to: new Date(to),
    previousFrom: new Date(from - days * DAY_MS),
    previousTo: new Date(from),
  };
}

// Jour UTC « AAAA-MM-JJ » d'une borne, pour l'affichage côté client.
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
