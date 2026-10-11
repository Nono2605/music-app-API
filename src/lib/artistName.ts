// Règles d'un nom d'artiste (fonctions pures). La base impose le strict nécessaire
// (longueur, caractères de contrôle, unicité, mots réservés : migration
// 20261011000000_catalog_numbers_and_artist_names.sql) ; ici on donne un message
// précis AVANT d'aller à la base. Le jeu de caractères accepté ici est plus étroit que
// celui de la base : tout nom valide ici l'est pour la base.
//
// Autorisé : lettres (toutes écritures), chiffres, espace et . - _ ' & !
// Le nom doit commencer par une lettre ou un chiffre et contenir au moins une lettre.

export const ARTIST_NAME_MIN = 2;
export const ARTIST_NAME_MAX = 40;

export type ArtistNameProblem =
  | "required"
  | "too_short"
  | "too_long"
  | "characters"
  | "starts_badly"
  | "no_letters"
  | "link"
  | "mixed_scripts";

const MESSAGES: Record<ArtistNameProblem, string> = {
  required: "Enter an artist name.",
  too_short: `Artist names need at least ${ARTIST_NAME_MIN} characters.`,
  too_long: `Artist names can have at most ${ARTIST_NAME_MAX} characters.`,
  characters: "Use letters, numbers, spaces and . - _ ' & ! only.",
  starts_badly: "The name must start with a letter or a number.",
  no_letters: "The name needs at least one letter.",
  link: "Artist names can't be links or web addresses.",
  mixed_scripts: "Don't mix Latin letters with Cyrillic or Greek ones.",
};

export type ArtistNameValidation =
  | { ok: true; name: string }
  | { ok: false; name: string; code: ArtistNameProblem; message: string };

// Forme canonique : apostrophes et tirets typographiques ramenés à ' et -, NFKC (les
// formes « larges » ou composées deviennent normales), espaces multiples réduits à un.
// L'ordre compte : NFKC transformerait ´ en « espace + accent », d'où le remplacement avant.
export function normalizeArtistName(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[‘’‛ʼ`´]/g, "'")
    .replace(/[‐-―−]/g, "-")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

const ALLOWED = /^[\p{L}\p{M}\p{N} .\-_'&!]+$/u;
const STARTS_WELL = /^[\p{L}\p{N}]/u;
const HAS_LETTER = /\p{L}/u;
const LINK = /(https?:|www\.)|[\p{L}\p{N}-]+\.(com|net|org|io|fm|ch|fr|de|uk|app|me|co|tv|xyz)(\b|$)/iu;
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC_OR_GREEK = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

export function validateArtistName(raw: unknown): ArtistNameValidation {
  const name = normalizeArtistName(raw);
  const fail = (code: ArtistNameProblem): ArtistNameValidation => ({
    ok: false,
    name,
    code,
    message: MESSAGES[code],
  });

  if (name === "") return fail("required");
  const length = [...name].length; // en caractères, pas en unités UTF-16
  if (length < ARTIST_NAME_MIN) return fail("too_short");
  if (length > ARTIST_NAME_MAX) return fail("too_long");
  if (!ALLOWED.test(name)) return fail("characters");
  if (!STARTS_WELL.test(name)) return fail("starts_badly");
  if (!HAS_LETTER.test(name)) return fail("no_letters");
  if (LINK.test(name)) return fail("link");
  // Un « a » cyrillique dans un nom latin est le truc classique pour imiter un autre artiste.
  if (LATIN.test(name) && CYRILLIC_OR_GREEK.test(name)) return fail("mixed_scripts");
  return { ok: true, name };
}

export type ArtistInsertError =
  | "name_taken"
  | "already_has_artist"
  | "slug_taken"
  | "name_reserved"
  | "name_format"
  | "other";

// Ce que dit la base quand l'INSERT d'un artiste échoue : une violation d'unicité peut
// venir du nom, du compte (un seul artiste par compte) ou du slug, qu'on distingue
// par le nom de l'index cité dans le message.
export function classifyArtistInsertError(error: { code?: string; message?: string } | null | undefined): ArtistInsertError {
  const code = error?.code;
  const message = String(error?.message ?? "");
  if (code === "23505") {
    if (message.includes("artists_name_key_unique")) return "name_taken";
    if (message.includes("artists_user_id_unique")) return "already_has_artist";
    return "slug_taken"; // artists_slug_key, ou toute autre unicité : on retente avec un suffixe
  }
  if (code === "23514") {
    if (message.includes("ARTIST_NAME_RESERVED")) return "name_reserved";
    if (message.includes("artists_name_format")) return "name_format";
  }
  return "other";
}

// Propositions quand un nom est pris : le nom suivi d'un mot neutre. « Official » est
// volontairement absent (il ferait croire à un compte officiel).
const SUFFIXES = ["Music", "Band", "Sound", "Beats", "Collective"];

export function suggestArtistNames(name: string): string[] {
  const out: string[] = [];
  for (const suffix of SUFFIXES) {
    const candidate = `${name} ${suffix}`;
    if (validateArtistName(candidate).ok) out.push(candidate);
  }
  return out;
}
