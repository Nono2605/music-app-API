// Détails d'un morceau et d'une release (migration 20261018000000_release_details.sql) : plusieurs genres,
// styles libres, artistes invités et crédits ; description, label, copyright, date de sortie.
// Fonctions pures qui nettoient et vérifient ce qui vient du client (jamais rien de fiable), testées avec
// `npm test`. L'existence d'un genre ou d'un artiste lié se vérifie ensuite en base.

import { GENRE_CODE } from "./genreCode";

export const MAX_GENRES = 3;
export const MAX_TAGS = 5;
export const MAX_CREDITS = 12;
export const CREDIT_ROLES = ["featured", "producer", "writer"] as const;
export type CreditRole = (typeof CREDIT_ROLES)[number];

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Jusqu'à 3 genres de la liste fermée ; le PREMIER est le genre principal. Tableau vide : aucun genre.
export function parseGenres(raw: unknown): Parsed<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "genres must be a list of genre codes" };
  const codes: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !GENRE_CODE.test(item)) {
      return { ok: false, error: "genres must be genre codes" };
    }
    if (!codes.includes(item)) codes.push(item);
  }
  if (codes.length > MAX_GENRES) return { ok: false, error: `Choose up to ${MAX_GENRES} genres.` };
  return { ok: true, value: codes };
}

// Le genre principal (colonne genre_code) et les autres (extra_genre_codes).
export function splitGenres(codes: string[]): { main: string | null; extras: string[] } {
  return { main: codes[0] ?? null, extras: codes.slice(1) };
}

// Le genre principal puis les autres, dans l'ordre : ce que le Studio affiche et renvoie.
export function joinGenres(main: unknown, extras: unknown): string[] {
  const codes: string[] = [];
  if (typeof main === "string" && main) codes.push(main);
  if (Array.isArray(extras)) {
    for (const code of extras) if (typeof code === "string" && code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

// Un style libre : minuscules, espaces simples, sans « # » devant ; lettres, chiffres, espaces, tiret et
// apostrophe ; 2 à 24 caractères.
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '-]{1,23}$/u;

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseTags(raw: unknown): Parsed<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "tags must be a list of words" };
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return { ok: false, error: "tags must be words" };
    const tag = normalizeTag(item);
    if (!tag) continue;
    if (!TAG_PATTERN.test(tag)) {
      return { ok: false, error: `“${tag.slice(0, 30)}” isn't a valid style tag: use 2 to 24 letters, numbers, spaces or hyphens.` };
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) return { ok: false, error: `Add up to ${MAX_TAGS} style tags.` };
  return { ok: true, value: tags };
}

export interface CreditInput {
  role: CreditRole;
  /** Un artiste Vynl, ou null pour une personne qui n'a pas de page. */
  artist_id: string | null;
  name: string;
}

// Artistes invités et autres crédits. Le nom suit les règles des noms d'artistes (pas de < > @ / \).
export function parseCredits(raw: unknown): Parsed<CreditInput[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "credits must be a list" };
  const credits: CreditInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { ok: false, error: "each credit must be an object" };
    const entry = item as Record<string, unknown>;

    const role = entry.role === undefined ? "featured" : entry.role;
    if (typeof role !== "string" || !(CREDIT_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: `A credit role must be one of: ${CREDIT_ROLES.join(", ")}.` };
    }

    const name = typeof entry.name === "string" ? entry.name.trim().replace(/\s+/g, " ") : "";
    if (name.length < 1 || name.length > 60) return { ok: false, error: "A credit needs a name of 1 to 60 characters." };
    if (CONTROL_CHARS.test(name) || /[<>@/\\]/.test(name)) {
      return { ok: false, error: "A credit name can't contain < > @ / \\ or control characters." };
    }

    let artistId: string | null = null;
    if (entry.artist_id !== undefined && entry.artist_id !== null && entry.artist_id !== "") {
      if (typeof entry.artist_id !== "string" || !UUID.test(entry.artist_id)) {
        return { ok: false, error: "A linked artist id is malformed." };
      }
      artistId = entry.artist_id.toLowerCase();
    }

    const key = `${role}:${artistId ?? name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    credits.push({ role: role as CreditRole, artist_id: artistId, name });
  }
  if (credits.length > MAX_CREDITS) return { ok: false, error: `Add up to ${MAX_CREDITS} credits per track.` };
  return { ok: true, value: credits };
}

export interface ReleaseDetails {
  /** undefined : inchangé ; null : effacé. */
  description?: string | null;
  label?: string | null;
  copyright_line?: string | null;
  release_date?: string | null;
}

const TEXT_LIMITS = { description: 1000, label: 80, copyright_line: 120 } as const;
const TEXT_LABELS = { description: "The description", label: "The label", copyright_line: "The copyright line" } as const;

// YYYY-MM-DD, une vraie date, entre 1900 et deux ans dans le futur (une sortie se prépare à l'avance).
export function parseReleaseDate(raw: string, now: Date = new Date()): Parsed<string> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return { ok: false, error: "The release date must look like 2026-10-31." };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, error: "This release date doesn't exist." };
  }
  const latest = Date.UTC(now.getUTCFullYear() + 2, now.getUTCMonth(), now.getUTCDate());
  if (year < 1900 || date.getTime() > latest) {
    return { ok: false, error: "The release date must be between 1900 and two years from now." };
  }
  return { ok: true, value: raw };
}

// Les champs facultatifs d'une release : absent = inchangé, vide ou null = effacé.
export function parseReleaseDetails(raw: unknown, now: Date = new Date()): Parsed<ReleaseDetails> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "The details must be an object." };
  }
  const body = raw as Record<string, unknown>;
  const details: ReleaseDetails = {};

  for (const field of ["description", "label", "copyright_line"] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null) {
      details[field] = null;
      continue;
    }
    if (typeof value !== "string") return { ok: false, error: `${TEXT_LABELS[field]} must be text.` };
    const text = value.trim();
    if (text.length > TEXT_LIMITS[field]) {
      return { ok: false, error: `${TEXT_LABELS[field]} can have up to ${TEXT_LIMITS[field]} characters.` };
    }
    if (CONTROL_CHARS.test(field === "description" ? text.replace(/[\n\r\t]/g, " ") : text)) {
      return { ok: false, error: `${TEXT_LABELS[field]} can't contain control characters.` };
    }
    details[field] = text || null;
  }

  if (body.release_date !== undefined) {
    if (body.release_date === null || body.release_date === "") {
      details.release_date = null;
    } else if (typeof body.release_date !== "string") {
      return { ok: false, error: "The release date must be text like 2026-10-31." };
    } else {
      const date = parseReleaseDate(body.release_date.trim(), now);
      if (!date.ok) return date;
      details.release_date = date.value;
    }
  }
  return { ok: true, value: details };
}
