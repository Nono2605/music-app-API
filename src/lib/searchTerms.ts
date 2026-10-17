// Recherche dans le catalogue public : ce que l'auditeur tape devient un filtre sur les titres, les styles, les
// genres et les crédits. Fonctions pures, testées avec `npm test` : un terme vient de la query string, donc de
// n'importe qui, et il est glissé dans une expression de filtre PostgREST.

import { GENRE_CODE } from "./genreCode";

export const MAX_TERM_LENGTH = 100;

// Le terme nettoyé : sans caractère de contrôle ni ceux qui ont un sens dans un filtre PostgREST ou un LIKE
// (virgule, parenthèses, guillemets, accolades, antislash, *, %, _), espaces simples. « 100% » cherche donc « 100 ».
export function cleanSearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f,()"{}\\*%_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TERM_LENGTH);
}

// ?genre=… : un code de la liste fermée, sinon rien.
export function parseGenreParam(raw: unknown): string | null {
  return typeof raw === "string" && GENRE_CODE.test(raw) ? raw : null;
}

const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '-]{1,23}$/u;

// Un style, mis en forme comme à l'enregistrement (minuscules, espaces simples, sans « # »), ou null si ce n'en
// est pas un.
export function parseTagParam(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tag = raw.trim().replace(/^#+/, "").trim().replace(/\s+/g, " ").toLowerCase();
  return TAG_PATTERN.test(tag) ? tag : null;
}

// Les genres dont le libellé contient le terme (« hop » trouve « Hip-hop / Rap »), ou dont le code est le terme.
// Moins de 3 lettres : on ne cherche pas, « po » ramènerait la moitié de la liste.
export function genreCodesMatching(term: string, genres: readonly { code: string; label: string }[]): string[] {
  const needle = term.trim().toLowerCase();
  if (needle.length < 3) return [];
  return genres
    .filter((genre) => genre.code === needle || genre.label.toLowerCase().includes(needle))
    .map((genre) => genre.code);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CREDITED = 100;

// L'expression « or » PostgREST de la recherche de morceaux : le terme dans le titre, un style qui porte ce
// nom, un genre dont le libellé le contient, ou un morceau où figure un artiste crédité de ce nom
// (`creditedTrackIds`). Le terme doit avoir été nettoyé (cleanSearch) ; les codes de genre et les identifiants
// sont revérifiés ici.
export function buildTrackSearchFilter(input: {
  term: string;
  genreCodes: readonly string[];
  creditedTrackIds: readonly string[];
}): string {
  const parts = [`title.ilike.%${input.term}%`];

  const tag = parseTagParam(input.term);
  if (tag) parts.push(`tags.cs.{"${tag}"}`);

  const codes = input.genreCodes.filter((code) => GENRE_CODE.test(code));
  if (codes.length > 0) {
    parts.push(`genre_code.in.(${codes.join(",")})`, `extra_genre_codes.ov.{${codes.join(",")}}`);
  }

  const ids = input.creditedTrackIds.filter((id) => UUID.test(id)).slice(0, MAX_CREDITED);
  if (ids.length > 0) parts.push(`id.in.(${ids.join(",")})`);

  return parts.join(",");
}

// Le filtre « or » d'un genre : le principal ou l'un des autres.
export function genreFilter(code: string): string {
  return `genre_code.eq.${code},extra_genre_codes.cs.{${code}}`;
}
