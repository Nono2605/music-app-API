import { chunk } from "./publicProvenance";
import { isMissingColumn, isMissingTable } from "./schemaCompat";
import { supabaseAdmin } from "./supabaseAdmin";
import { EMPTY_META, buildTrackMeta, type CreditRow, type TrackMeta } from "./trackMeta";

// Lecture en base des genres, styles et crédits des morceaux (migration 20261018000000_release_details.sql), pour
// les routes qui renvoient des morceaux à l'app d'écoute. Les règles de mise en forme sont dans trackMeta.ts
// (pures, testées). Ce sont des informations SECONDAIRES : si la lecture échoue ou si la migration n'est pas
// appliquée, les morceaux sont renvoyés sans (listes vides) plutôt que de faire échouer la page.

const BATCH = 100;
const LABELS_TTL_MS = 5 * 60 * 1000;

type Rows = { data: Record<string, unknown>[] | null; error: { code?: string; message?: string } | null };

async function selectIn(table: string, columns: string, column: string, ids: string[]): Promise<Rows> {
  return (await supabaseAdmin.from(table).select(columns).in(column, ids)) as unknown as Rows;
}

let labelsCache: { at: number; labels: Map<string, string> } | null = null;

// Les libellés de TOUS les genres (actifs ou non : un genre désactivé garde son nom sur les morceaux qui l'ont),
// gardés cinq minutes en mémoire : la liste compte une trentaine de lignes et change rarement.
export async function loadGenreLabels(): Promise<Map<string, string>> {
  if (labelsCache && Date.now() - labelsCache.at < LABELS_TTL_MS) return labelsCache.labels;
  const { data, error } = await supabaseAdmin.from("genres").select("code, label");
  if (error) {
    if (!isMissingTable(error)) console.error("Could not read the genre labels:", error.message);
    return new Map();
  }
  const labels = new Map((data ?? []).map((row) => [String(row.code), String(row.label)]));
  labelsCache = { at: Date.now(), labels };
  return labels;
}

// Genres, styles et crédits de chaque morceau demandé. Un morceau sans rien, ou toute panne : EMPTY_META.
export async function loadTrackMeta(trackIds: readonly string[]): Promise<Map<string, TrackMeta>> {
  const unique = [...new Set(trackIds)];
  const result = new Map<string, TrackMeta>(unique.map((id) => [id, EMPTY_META]));
  if (unique.length === 0) return result;

  try {
    const labels = await loadGenreLabels();
    const batches = await Promise.all(
      chunk(unique, BATCH).map(async (ids) => {
        let tracks = await selectIn("tracks", "id, genre_code, extra_genre_codes, tags", "id", ids);
        // Avant la migration des détails : seulement le genre principal (et rien du tout avant celle des genres).
        if (tracks.error && isMissingColumn(tracks.error)) tracks = await selectIn("tracks", "id, genre_code", "id", ids);
        if (tracks.error) {
          if (isMissingColumn(tracks.error)) return { tracks: [], credits: [] };
          throw tracks.error;
        }

        const withStatus = "track_id, role, display_name, position, artist_id, artists(slug, anonymized_at, name_status)";
        let credits = await selectIn("track_credits", withStatus, "track_id", ids);
        if (credits.error && isMissingColumn(credits.error)) {
          credits = await selectIn(
            "track_credits",
            "track_id, role, display_name, position, artist_id, artists(slug, anonymized_at)",
            "track_id",
            ids
          );
        }
        if (credits.error && !isMissingTable(credits.error)) throw credits.error;
        return { tracks: tracks.data ?? [], credits: credits.error ? [] : (credits.data ?? []) };
      })
    );

    const creditsByTrack = new Map<string, CreditRow[]>();
    for (const row of batches.flatMap((batch) => batch.credits)) {
      const trackId = String(row.track_id);
      creditsByTrack.set(trackId, [...(creditsByTrack.get(trackId) ?? []), row as unknown as CreditRow]);
    }
    for (const row of batches.flatMap((batch) => batch.tracks)) {
      const id = String(row.id);
      result.set(
        id,
        buildTrackMeta({
          labels,
          genreCode: row.genre_code,
          extraGenreCodes: row.extra_genre_codes,
          tags: row.tags,
          credits: creditsByTrack.get(id) ?? [],
        })
      );
    }
  } catch (err) {
    console.error("Could not read the track details:", (err as { message?: string })?.message ?? err);
  }
  return result;
}

// Les morceaux où figure un artiste crédité dont le nom contient le terme (déjà nettoyé : cleanSearch). Au plus 100.
// Sans la table des crédits : aucun.
export async function creditedTrackIds(term: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("track_credits")
    .select("track_id")
    .ilike("display_name", `%${term}%`)
    .limit(100);
  if (error) {
    if (!isMissingTable(error)) console.error("Could not search the credits:", error.message);
    return [];
  }
  return [...new Set((data ?? []).map((row) => String(row.track_id)))];
}
