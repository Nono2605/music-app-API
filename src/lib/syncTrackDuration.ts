import { supabaseAdmin } from "./supabaseAdmin";
import { pickTrackDuration } from "./trackDuration";

/**
 * Aligne tracks.duration_seconds sur les fichiers du morceau (règle dans
 * trackDuration.ts). À rappeler après tout ajout, retrait ou mesure de fichier.
 * Renvoie la nouvelle durée, ou `undefined` si rien n'a été modifié.
 */
export async function syncTrackDuration(trackId: string): Promise<number | null | undefined> {
  const { data: files, error } = await supabaseAdmin
    .from("track_files")
    .select("created_at, duration_seconds")
    .eq("track_id", trackId);
  if (error) throw error;

  const duration = pickTrackDuration(files ?? []);
  if (duration === undefined) return undefined;

  const { error: updateError } = await supabaseAdmin
    .from("tracks")
    .update({ duration_seconds: duration })
    .eq("id", trackId);
  if (updateError) throw updateError;
  return duration;
}
