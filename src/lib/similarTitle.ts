// Contrôle D4 (spec 15.5) : un morceau d'UN AUTRE artiste qui porte le même titre et dure presque autant (à 2 secondes
// près). Un simple avertissement pour la relecture : deux œuvres peuvent légitimement s'appeler « Intro ». Le même
// artiste qui republie son titre (un single puis l'album) n'est pas concerné.
//
// Même règle que celle de l'admin (Vynl-AdminApp/src/lib/similarTracks.ts), qui la montre en direct sur la fiche du
// morceau ; ici elle est exécutée à l'envoi en relecture et son résultat gardé dans le journal des contrôles.

// Écart de durée toléré, en secondes (spec 15.5, D4).
export const SIMILAR_DURATION_SECONDS = 2;

export interface TrackLite {
  id: string;
  title: string;
  duration_seconds: number | null;
  artist_id: string;
}

// Titre comparable : sans casse, sans accents, sans ponctuation, espaces réduits.
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function findSimilarTracks(track: TrackLite, candidates: TrackLite[]): TrackLite[] {
  if (track.duration_seconds === null) return [];
  const title = normalizeTitle(track.title);
  if (title === "") return [];
  return candidates.filter(
    (other) =>
      other.id !== track.id &&
      other.artist_id !== track.artist_id &&
      other.duration_seconds !== null &&
      Math.abs(other.duration_seconds - track.duration_seconds!) <= SIMILAR_DURATION_SECONDS &&
      normalizeTitle(other.title) === title
  );
}

// Échappe % _ et \ pour une recherche « ilike » qui doit comprendre le titre à la lettre.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Juste ce qu'il faut du client Supabase, pour pouvoir le remplacer dans les tests.
interface TitleQuery extends PromiseLike<{ data: unknown[] | null; error: unknown }> {
  ilike(column: string, pattern: string): TitleQuery;
  neq(column: string, value: string): TitleQuery;
  limit(count: number): TitleQuery;
}
export interface TitleDb {
  from(table: string): { select(columns: string): TitleQuery };
}

// Les morceaux de même titre (à la casse près) chez d'autres artistes, puis ceux dont la durée est voisine. Les variantes
// d'accents ou de ponctuation ne sont pas cherchées en base (limite connue) ; findSimilarTracks, lui, les accepterait.
// LÈVE l'erreur si la recherche échoue : un contrôle en panne ne doit pas passer pour « rien à signaler ».
export async function loadSimilarTracks(db: TitleDb, track: TrackLite): Promise<TrackLite[]> {
  if (track.duration_seconds === null || normalizeTitle(track.title) === "") return [];
  const { data, error } = await db
    .from("tracks")
    .select("id, title, duration_seconds, artist_id")
    .ilike("title", escapeLike(track.title.trim()))
    .neq("artist_id", track.artist_id)
    .limit(50);
  if (error) throw error;
  return findSimilarTracks(track, (data ?? []) as TrackLite[]);
}
