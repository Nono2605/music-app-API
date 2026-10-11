// Paramètres et forme de réponse de GET /albums. Fonctions pures (testées sans base).

export interface ListParams {
  limit: number;
  offset: number;
  q: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 100;

// `query` vient de la query string : n'importe quoi (absent, tableau, texte, NaN).
// Une valeur inutilisable retombe sur le défaut plutôt que de faire échouer la requête.
export function parseListParams(query: Record<string, unknown>): ListParams {
  const integer = (raw: unknown): number | null => {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  };

  const limit = integer(query.limit);
  const offset = integer(query.offset);
  const q = typeof query.q === "string" ? query.q.trim().slice(0, MAX_QUERY_LENGTH) : "";

  return {
    limit: limit === null || limit < 1 ? DEFAULT_LIMIT : Math.min(limit, MAX_LIMIT),
    offset: offset === null || offset < 0 ? 0 : offset,
    q,
  };
}

// Motif ilike « contient q » : \, % et _ sont des caractères spéciaux de LIKE, on
// les échappe pour que la recherche « 100% » ne trouve pas tout le catalogue.
export function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

type OneOrMany<T> = T | T[] | null;

export interface AlbumRow {
  id: string;
  title: string;
  cover_url: string | null;
  release_date: string | null;
  type: string;
  artists: OneOrMany<{ name: string; slug: string }>;
  tracks: { id: string }[] | null;
}

export interface AlbumSummary {
  id: string;
  title: string;
  cover_url: string | null;
  release_date: string | null;
  type: string;
  artists: { name: string; slug: string } | null;
  track_count: number;
}

// Selon les types générés, PostgREST renvoie la relation many-to-one en objet ou
// en tableau d'un élément : on accepte les deux et on renvoie toujours un objet.
export function toAlbumSummary(row: AlbumRow): AlbumSummary {
  const artist = Array.isArray(row.artists) ? (row.artists[0] ?? null) : row.artists;
  return {
    id: row.id,
    title: row.title,
    cover_url: row.cover_url,
    release_date: row.release_date,
    type: row.type,
    artists: artist,
    track_count: row.tracks?.length ?? 0,
  };
}
