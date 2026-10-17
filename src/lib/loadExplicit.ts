import { anyExplicit } from "./explicit";
import { chunk } from "./publicProvenance";
import { supabaseAdmin } from "./supabaseAdmin";

// Les identifiants vont dans l'URL de la requête (in.(…)) : on interroge par lots (voir loadProvenance.ts).
const BATCH = 100;

/** Les albums (ou singles) demandés dont au moins un morceau PUBLIÉ est explicite. */
export async function loadExplicitAlbums(albumIds: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(albumIds)];
  if (unique.length === 0) return new Set();

  const batches = await Promise.all(
    chunk(unique, BATCH).map(async (ids) => {
      const { data, error } = await supabaseAdmin
        .from("tracks")
        .select("album_id, explicit")
        .in("album_id", ids)
        .eq("status", "published")
        .eq("explicit", true);
      if (error) throw error;
      return data ?? [];
    })
  );

  const found = new Set<string>();
  for (const row of batches.flat()) if (anyExplicit([row])) found.add(row.album_id as string);
  return found;
}
