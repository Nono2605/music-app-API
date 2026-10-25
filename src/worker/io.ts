// Les branchements réels du worker : stockage Supabase, ffmpeg, mesure de la durée, R2 et base. Le travail lui-même
// est dans transcodeJob.ts, testé sans rien de tout cela.
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { supabaseAdmin } from "../lib/supabaseAdmin";
import { MAX_AUDIO_BYTES } from "../lib/audioProbe";
import { buildAacArgs, runFfmpeg } from "./ffmpeg";
import { createR2 } from "./r2";
import type { WorkerConfig } from "./config";
import type { DeletionIo, TranscodeIo } from "./transcodeJob";

const AUDIO_BUCKET = "track-audio";
const DOWNLOAD_URL_SECONDS = 30 * 60;
const MAX_DELETION_ATTEMPTS = 10;

export function createIo(config: WorkerConfig) {
  const r2 = createR2(config.r2);

  const transcode: TranscodeIo = {
    async existingBitrates(fileId) {
      const { data, error } = await supabaseAdmin.from("track_renditions").select("bitrate_kbps").eq("source_file_id", fileId);
      if (error) throw error;
      return (data ?? []).map((row) => row.bitrate_kbps as number);
    },

    async makeWorkDir() {
      const dir = await mkdtemp(join(tmpdir(), "vynl-transcode-"));
      return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },

    async download(storageKey, dest) {
      const { data: signed, error } = await supabaseAdmin.storage.from(AUDIO_BUCKET).createSignedUrl(storageKey, DOWNLOAD_URL_SECONDS);
      if (error) throw error;
      const response = await fetch(signed.signedUrl, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Téléchargement de l'original impossible (HTTP ${response.status})`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) throw new Error("L'original dépasse la taille maximale");
      await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
      if ((await stat(dest)).size > MAX_AUDIO_BYTES) throw new Error("L'original dépasse la taille maximale");
    },

    async probeDuration(path) {
      // music-metadata est ESM seulement : import dynamique, comme dans lib/audioProbe.ts.
      const { parseFile } = await import("music-metadata");
      const info = (await parseFile(path, { duration: true })).format;
      if (typeof info.duration !== "number" || !Number.isFinite(info.duration) || info.duration <= 0) {
        throw new Error("Durée illisible : fichier audio non reconnu");
      }
      return info.duration;
    },

    encode: (input, output, kbps) => runFfmpeg(config.ffmpegPath, buildAacArgs(input, output, kbps)),

    fileSize: async (path) => (await stat(path)).size,

    upload: (key, path, size) => r2.put(key, path, size),

    removeUploaded: (key) => r2.remove(key),

    async saveRendition(row) {
      const { error } = await supabaseAdmin
        .from("track_renditions")
        .upsert(row, { onConflict: "source_file_id,bitrate_kbps", ignoreDuplicates: true });
      if (error) throw error;
    },
  };

  const deletions: DeletionIo = {
    async list(limit) {
      const { data, error } = await supabaseAdmin
        .from("cdn_object_deletions")
        .select("id, storage_key, attempts")
        .lt("attempts", MAX_DELETION_ATTEMPTS)
        .order("id", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    deleteObject: (key) => r2.remove(key),
    async remove(id) {
      const { error } = await supabaseAdmin.from("cdn_object_deletions").delete().eq("id", id);
      if (error) throw error;
    },
    async markFailed(id, message, attempts) {
      await supabaseAdmin.from("cdn_object_deletions").update({ last_error: message.slice(0, 500), attempts }).eq("id", id);
    },
  };

  return { transcode, deletions };
}
