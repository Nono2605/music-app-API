import { supabaseAdmin } from "./supabaseAdmin";
import { albumProvenance, chunk, publicProvenance, type PublicProvenance } from "./publicProvenance";
import { latestDeclarations } from "./provenance";

// Lecture de la provenance publique en base, pour les routes qui renvoient des morceaux ou des
// albums à l'app d'écoute. Les règles sont dans publicProvenance.ts (pures, testées).

// Les identifiants vont dans l'URL de la requête (in.(…)) : une liste longue (une bibliothèque,
// la discographie d'un artiste) la ferait dépasser la limite. On interroge par lots.
const BATCH = 100;

export type ProvenanceByTrack = Map<string, PublicProvenance | null>;

/** Provenance publique de chaque morceau demandé (null : pas de badge). Un morceau sans ligne est null. */
export async function loadTrackProvenance(trackIds: readonly string[]): Promise<ProvenanceByTrack> {
  const unique = [...new Set(trackIds)];
  const result: ProvenanceByTrack = new Map(unique.map((id) => [id, null]));
  if (unique.length === 0) return result;

  const batches = await Promise.all(
    chunk(unique, BATCH).map(async (ids) => {
      const { data, error } = await supabaseAdmin
        .from("ai_declarations")
        .select("track_id, provenance, status")
        .in("track_id", ids)
        .order("declared_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    })
  );

  // Les lignes de chaque lot sont triées de la plus récente à la plus ancienne ; un morceau n'est
  // que dans un lot, donc garder la première ligne de chaque morceau donne sa dernière déclaration.
  for (const [trackId, latest] of latestDeclarations(batches.flat())) result.set(trackId, publicProvenance(latest));
  return result;
}

/** Provenance publique de chaque album demandé, d'après ses morceaux PUBLIÉS. */
export async function loadAlbumProvenance(albumIds: readonly string[]): Promise<Map<string, PublicProvenance | null>> {
  const unique = [...new Set(albumIds)];
  const result = new Map<string, PublicProvenance | null>(unique.map((id) => [id, null]));
  if (unique.length === 0) return result;

  const batches = await Promise.all(
    chunk(unique, BATCH).map(async (ids) => {
      const { data, error } = await supabaseAdmin
        .from("tracks")
        .select("id, album_id")
        .in("album_id", ids)
        .eq("status", "published");
      if (error) throw error;
      return data ?? [];
    })
  );
  const tracks = batches.flat();

  const byTrack = await loadTrackProvenance(tracks.map((t) => t.id));
  const grouped = new Map<string, (PublicProvenance | null)[]>();
  for (const t of tracks) {
    const list = grouped.get(t.album_id as string) ?? [];
    list.push(byTrack.get(t.id) ?? null);
    grouped.set(t.album_id as string, list);
  }
  for (const [albumId, list] of grouped) result.set(albumId, albumProvenance(list));
  return result;
}
