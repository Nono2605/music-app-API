import { env } from "../config/env";
import { supabaseAdmin } from "./supabaseAdmin";
import { DEFAULT_QUALITY, type Rendition, type StreamQuality } from "./renditions";
import { resolveStream, STREAM_URL_SECONDS, type ResolvedStream, type SourceFile, type StreamDeps } from "./resolveStream";

const AUDIO_BUCKET = "track-audio";

// Une panne du CDN ne doit pas noyer les journaux (une écoute = une requête) : un message par minute au plus.
let lastCdnWarning = 0;
function warnCdnFailure(err: unknown) {
  const now = Date.now();
  if (now - lastCdnWarning < 60_000) return;
  lastCdnWarning = now;
  console.warn("CDN indisponible, repli sur Supabase :", err instanceof Error ? err.message : err);
}

const realDeps: StreamDeps = {
  async loadSourceFile(trackId) {
    const { data: file, error } = await supabaseAdmin
      .from("track_files")
      .select("id, storage_key, format")
      .eq("track_id", trackId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return file as SourceFile | null;
  },

  async loadRenditions(sourceFileId) {
    const { data, error } = await supabaseAdmin
      .from("track_renditions")
      .select("storage_key, bitrate_kbps")
      .eq("source_file_id", sourceFileId);
    if (error) throw error;
    return (data ?? []) as Rendition[];
  },

  async signOriginal(file) {
    const { data: signed, error } = await supabaseAdmin.storage.from(AUDIO_BUCKET).createSignedUrl(file.storage_key, STREAM_URL_SECONDS);
    if (error) throw error;
    return signed.signedUrl;
  },

  nowSeconds: () => Math.floor(Date.now() / 1000),
  onCdnError: warnCdnFailure,
};

/**
 * Adresse d'écoute d'un morceau : la version AAC du CDN quand elle est prête (lib/resolveStream.ts), sinon le
 * fichier original, le plus ancien du morceau, chez Supabase (voir trackDuration.ts). `null` si le morceau n'a
 * aucun fichier.
 */
export async function signedStreamUrl(trackId: string, quality: StreamQuality = DEFAULT_QUALITY): Promise<ResolvedStream | null> {
  return resolveStream(realDeps, env.cdn, trackId, quality);
}
