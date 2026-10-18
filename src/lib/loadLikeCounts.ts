import { countsFromRows, countsFromRpc } from "./likeCounts";
import { chunk } from "./publicProvenance";
import { isMissingFunction } from "./schemaCompat";
import { supabaseAdmin } from "./supabaseAdmin";

// Les identifiants vont dans l'URL de la requête (in.(…)) : on interroge par lots (voir loadProvenance.ts).
const BATCH = 100;
// Repli sans la fonction SQL : PostgREST rend 1 000 lignes au plus par requête, on pagine, et on s'arrête
// à ce plafond (un nombre au moins exact jusque-là) plutôt que de lire toute la table.
const PAGE = 1000;
const MAX_PAGES = 10;

async function countByRows(ids: string[]): Promise<Map<string, number>> {
  const rows: { item_id: string }[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabaseAdmin
      .from("library")
      .select("item_id")
      .eq("item_type", "track")
      .in("item_id", ids)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return countsFromRows(ids, rows);
}

/**
 * Le nombre de « j'aime » de chaque morceau demandé (zéro pour un morceau que personne n'a aimé).
 * Utilise la fonction SQL track_like_counts (migration 20261018100000) ; tant qu'elle n'est pas
 * appliquée, retombe sur un comptage ligne par ligne, correct mais plus lent.
 */
export async function loadTrackLikeCounts(trackIds: readonly string[]): Promise<Map<string, number>> {
  const unique = [...new Set(trackIds)];
  const result = new Map<string, number>(unique.map((id) => [id, 0]));
  if (unique.length === 0) return result;

  const batches = await Promise.all(
    chunk(unique, BATCH).map(async (ids) => {
      const { data, error } = await supabaseAdmin.rpc("track_like_counts", { p_track_ids: ids });
      if (!error) return countsFromRpc(ids, data as { track_id: string; likes: number | string | null }[] | null);
      if (isMissingFunction(error)) return countByRows(ids);
      throw error;
    })
  );
  for (const counts of batches) for (const [id, likes] of counts) result.set(id, likes);
  return result;
}
