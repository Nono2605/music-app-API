// Ce que l'app d'écoute montre des détails d'un morceau (migration 20261018000000_release_details.sql) :
// ses genres (le principal d'abord), ses styles et ses crédits (artistes invités, producteur, auteur).
// Fonctions pures, testées avec `npm test` ; la lecture en base est dans loadTrackMeta.ts.

export interface GenreRef {
  code: string;
  label: string;
}

export interface PublicCredit {
  role: string;
  name: string;
  /** La page de l'artiste Vynl crédité (lien) ; null pour une personne qui n'a pas de page. */
  slug: string | null;
}

export interface TrackMeta {
  genres: GenreRef[];
  tags: string[];
  credits: PublicCredit[];
}

export const EMPTY_META: TrackMeta = { genres: [], tags: [], credits: [] };

type OneOrMany<T> = T | T[] | null | undefined;

export interface CreditRow {
  role: unknown;
  display_name: unknown;
  position: unknown;
  /** L'artiste lié, tel que le renvoie l'embarquement PostgREST (objet, tableau ou null). */
  artists?: OneOrMany<{ slug?: unknown; anonymized_at?: unknown; name_status?: unknown }>;
  artist_id?: unknown;
}

function first<T>(value: OneOrMany<T>): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

// Les genres d'un morceau : le principal d'abord, puis les autres, chacun avec son libellé. Un code que la liste
// ne connaît pas est ignoré (rien à afficher).
export function buildGenres(
  main: unknown,
  extras: unknown,
  labels: ReadonlyMap<string, string>
): GenreRef[] {
  const codes: string[] = [];
  if (typeof main === "string" && main) codes.push(main);
  if (Array.isArray(extras)) {
    for (const code of extras) if (typeof code === "string" && code && !codes.includes(code)) codes.push(code);
  }
  return codes.flatMap((code) => {
    const label = labels.get(code);
    return label ? [{ code, label }] : [];
  });
}

// Les crédits d'un morceau, dans l'ordre choisi par l'artiste. Un artiste dont le compte est supprimé
// (anonymisé) disparaît des crédits : son nom, copié dans le crédit, ne doit plus s'afficher. Un lien n'est
// donné que vers un artiste dont le nom est accepté.
export function buildCredits(rows: readonly CreditRow[]): PublicCredit[] {
  const credits: { position: number; credit: PublicCredit }[] = [];
  for (const row of rows) {
    if (typeof row.display_name !== "string" || !row.display_name) continue;
    const artist = first(row.artists);
    if (row.artist_id && artist && artist.anonymized_at) continue;

    const approved = artist && !artist.anonymized_at && (artist.name_status === undefined || artist.name_status === "approved");
    credits.push({
      position: typeof row.position === "number" ? row.position : 0,
      credit: {
        role: typeof row.role === "string" ? row.role : "featured",
        name: row.display_name,
        slug: approved && typeof artist.slug === "string" ? artist.slug : null,
      },
    });
  }
  return credits.sort((a, b) => a.position - b.position).map((entry) => entry.credit);
}

export function buildTrackMeta(input: {
  labels: ReadonlyMap<string, string>;
  genreCode: unknown;
  extraGenreCodes: unknown;
  tags: unknown;
  credits: readonly CreditRow[];
}): TrackMeta {
  return {
    genres: buildGenres(input.genreCode, input.extraGenreCodes, input.labels),
    tags: Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [],
    credits: buildCredits(input.credits),
  };
}

// Les genres qui reviennent le plus parmi des morceaux (la page d'un album, d'un artiste) : les plus fréquents
// d'abord, à égalité dans l'ordre où ils apparaissent. Seuls les morceaux publiés sont passés ici.
export function topGenres(metas: Iterable<TrackMeta>, limit = 5): GenreRef[] {
  const counts = new Map<string, { genre: GenreRef; count: number; order: number }>();
  let order = 0;
  for (const meta of metas) {
    for (const genre of meta.genres) {
      const known = counts.get(genre.code);
      if (known) known.count += 1;
      else counts.set(genre.code, { genre, count: 1, order: order++ });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.genre);
}

// Les champs ajoutés à un morceau dans les réponses de l'API.
export function metaFields(meta: TrackMeta | undefined): TrackMeta {
  return meta ?? EMPTY_META;
}
