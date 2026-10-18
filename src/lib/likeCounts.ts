// Nombre de « j'aime » par morceau : les règles, sans base (testées par likeCounts.test.ts).
//
// Un « j'aime » est une ligne de `library` de type « track ». Seul le nombre est public, jamais qui.

/** Les lignes `{ track_id, likes }` de la fonction SQL track_like_counts, en une table id → nombre. */
export function countsFromRpc(
  ids: readonly string[],
  rows: readonly { track_id: string; likes: number | string | null }[] | null | undefined
): Map<string, number> {
  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const row of rows ?? []) {
    const likes = Number(row.likes);
    if (counts.has(row.track_id) && Number.isFinite(likes) && likes > 0) counts.set(row.track_id, Math.floor(likes));
  }
  return counts;
}

/** Repli sans la fonction SQL : une ligne de `library` par « j'aime », qu'on compte ici. */
export function countsFromRows(
  ids: readonly string[],
  rows: readonly { item_id: string }[] | null | undefined
): Map<string, number> {
  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const row of rows ?? []) {
    const current = counts.get(row.item_id);
    if (current !== undefined) counts.set(row.item_id, current + 1);
  }
  return counts;
}
