import { supabaseAdmin } from "./supabaseAdmin";

const AUDIO_BUCKET = "track-audio";
const STREAM_URL_SECONDS = 60 * 60 * 6;

/**
 * URL signée vers le fichier audio d'un morceau : le plus ancien, celui dont la
 * durée est enregistrée sur le morceau (voir trackDuration.ts). `null` s'il n'a
 * aucun fichier.
 */
export async function signedStreamUrl(trackId: string): Promise<{ url: string; format: string } | null> {
  const { data: file, error } = await supabaseAdmin
    .from("track_files")
    .select("storage_key, format")
    .eq("track_id", trackId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!file) return null;

  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(file.storage_key, STREAM_URL_SECONDS);
  if (signError) throw signError;
  return { url: signed.signedUrl, format: file.format };
}
