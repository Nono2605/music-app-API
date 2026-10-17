import { isMissingColumn, isMissingTable } from "./schemaCompat";
import { supabaseAdmin } from "./supabaseAdmin";

// Genre d'un morceau : une liste FERMÉE (table genres, colonne tracks.genre_code ; migration
// 20261014000002_genres.sql ; spec section 16). L'API reste fonctionnelle avant la migration :
//  - la liste répond « indisponible » ;
//  - le genre d'un morceau n'est pas exigé à l'envoi en relecture.

export { GENRE_CODE } from "./genreCode";
import { GENRE_CODE } from "./genreCode";

export type GenreInput = { ok: true; value: string | null } | { ok: false; error: string };

// null ou "" : retirer le genre. Sinon un code de la forme attendue (l'existence se vérifie en base).
export function parseGenreInput(raw: unknown): GenreInput {
  if (raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw === "string" && GENRE_CODE.test(raw)) return { ok: true, value: raw };
  return { ok: false, error: "genre must be a genre code (or null to clear it)" };
}

export function genreProblem(genreCode: string | null | undefined): string | null {
  return genreCode ? null : "Choose a genre before submitting this track for review.";
}

export function releaseGenreProblem(tracks: { title: string; genre_code?: string | null }[]): string | null {
  const missing = tracks.filter((track) => !track.genre_code);
  if (missing.length === 0) return null;

  const shown = missing.slice(0, 3).map((track) => `“${track.title}”`);
  const more = missing.length - shown.length;
  const list = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
  const noun = missing.length === 1 ? "1 track has" : `${missing.length} tracks have`;
  return `${noun} no genre yet: ${list}. Choose a genre on each track's page first.`;
}

// Juste ce qu'il faut du client Supabase, remplaçable dans les tests.
interface Query<T> extends PromiseLike<{ data: T[] | null; error: unknown }> {
  eq(column: string, value: unknown): Query<T>;
  in(column: string, values: unknown[]): Query<T>;
  order(column: string, options?: { ascending: boolean }): Query<T>;
  limit(count: number): Query<T>;
}
export interface GenreDb {
  from(table: string): {
    select(columns: string): Query<Record<string, unknown>>;
    update(values: Record<string, unknown>): { eq(column: string, value: unknown): PromiseLike<{ error: unknown }> };
  };
}
const defaultDb = () => supabaseAdmin as unknown as GenreDb;

export class GenresUnavailableError extends Error {}

export interface GenreOption {
  code: string;
  label: string;
}

export async function listGenres(db: GenreDb = defaultDb()): Promise<GenreOption[]> {
  const { data, error } = await db.from("genres").select("code, label").eq("active", true).order("sort_order");
  if (error) {
    if (isMissingTable(error)) throw new GenresUnavailableError("genres table is missing");
    throw error;
  }
  return (data ?? []).map((row) => ({ code: String(row.code), label: String(row.label) }));
}

export async function isActiveGenre(code: string, db: GenreDb = defaultDb()): Promise<boolean> {
  const { data, error } = await db.from("genres").select("code").eq("code", code).eq("active", true).limit(1);
  if (error) {
    if (isMissingTable(error)) throw new GenresUnavailableError("genres table is missing");
    throw error;
  }
  return (data ?? []).length > 0;
}

// Le genre d'un morceau : le code, null s'il n'en a pas, undefined si la colonne n'existe pas encore.
export async function readTrackGenre(trackId: string, db: GenreDb = defaultDb()): Promise<string | null | undefined> {
  const { data, error } = await db.from("tracks").select("genre_code").eq("id", trackId).limit(1);
  if (error) {
    if (isMissingColumn(error)) return undefined;
    throw error;
  }
  const code = data?.[0]?.genre_code;
  return typeof code === "string" ? code : null;
}

// Pour plusieurs morceaux : null si la colonne n'existe pas encore.
export async function readTrackGenres(trackIds: string[], db: GenreDb = defaultDb()): Promise<Map<string, string | null> | null> {
  if (trackIds.length === 0) return new Map();
  const { data, error } = await db.from("tracks").select("id, genre_code").in("id", trackIds);
  if (error) {
    if (isMissingColumn(error)) return null;
    throw error;
  }
  return new Map((data ?? []).map((row) => [String(row.id), typeof row.genre_code === "string" ? row.genre_code : null]));
}

export async function writeTrackGenre(trackId: string, code: string | null, db: GenreDb = defaultDb()): Promise<void> {
  const { error } = await db.from("tracks").update({ genre_code: code }).eq("id", trackId);
  if (error) {
    if (isMissingColumn(error)) throw new GenresUnavailableError("tracks.genre_code is missing");
    throw error;
  }
}
