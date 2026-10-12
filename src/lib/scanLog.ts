import { isMissingTable } from "./schemaCompat";
import { supabaseAdmin } from "./supabaseAdmin";

// Journal des contrôles (table track_scans, spec 15.5 D8) : la preuve de ce qui a été contrôlé, quand, par
// quoi, avec quel résultat. Écriture « au mieux » : si la table n'existe pas encore (migration pas
// appliquée) ou si l'écriture échoue, on le journalise et on continue. Un contrôle ne doit jamais empêcher
// le travail d'un artiste. Jamais de donnée personnelle dans `detail`.

export interface ScanRecord {
  track_id?: string | null;
  track_file_id?: string | null;
  artist_id?: string | null;
  check_kind: string;
  provider?: string;
  provider_version?: string | null;
  result: "ok" | "warn" | "fail";
  score?: number | null;
  matched_track_id?: string | null;
  matched_artist_id?: string | null;
  detail?: Record<string, unknown>;
}

export interface ScanDb {
  from(table: string): { insert(rows: unknown): PromiseLike<{ error: unknown }> };
}

export async function recordScans(records: ScanRecord[], db: ScanDb = supabaseAdmin as unknown as ScanDb): Promise<void> {
  if (records.length === 0) return;
  try {
    const { error } = await db.from("track_scans").insert(records);
    if (error && !isMissingTable(error)) {
      console.error("Could not record scans:", (error as { message?: string }).message ?? error);
    }
  } catch (err) {
    console.error("Could not record scans:", (err as { message?: string })?.message ?? err);
  }
}

// Un fichier identique à celui d'un autre artiste a été refusé à l'envoi.
export function duplicateFileScan(input: {
  trackId: string;
  artistId: string;
  matchedTrackId: string;
  matchedFileId: string;
}): ScanRecord {
  return {
    track_id: input.trackId,
    artist_id: input.artistId,
    check_kind: "file_hash",
    result: "fail",
    score: 1,
    matched_track_id: input.matchedTrackId,
    detail: { reason: "identical_sha256", matched_file_id: input.matchedFileId || null, blocked_upload: true },
  };
}

// Des noms d'artistes proches ont été trouvés à la création d'un artiste : à relire, pas bloquant.
export function nameSimilarityScans(
  artistId: string,
  similar: { artist_id: string; name: string; similarity: number }[]
): ScanRecord[] {
  return similar.map((match) => ({
    artist_id: artistId,
    check_kind: "name_similarity",
    result: "warn" as const,
    score: Number(match.similarity.toFixed(3)),
    matched_artist_id: match.artist_id,
    detail: { matched_name: match.name },
  }));
}
