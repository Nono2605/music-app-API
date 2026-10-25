// Réglages du worker de transcodage, lus dans l'environnement (Render > le service « worker » > Environment).
// Les clés R2 ne vivent QUE là : jamais dans le dépôt, jamais dans un fichier, jamais dans une conversation.
//
//   R2_ACCOUNT_ID         identifiant du compte Cloudflare (tableau de bord > R2 > à droite)
//   R2_ACCESS_KEY_ID      } créés dans R2 > Manage API tokens (droit « Object Read & Write » sur le seul bucket
//   R2_SECRET_ACCESS_KEY  } vynlmusic), affichés une seule fois à la création
//   R2_BUCKET             facultatif, « vynlmusic » par défaut
//   FFMPEG_PATH           facultatif : un ffmpeg déjà installé ; sinon celui du paquet ffmpeg-static
//   TRANSCODE_POLL_SECONDS  facultatif : pause quand il n'y a rien à faire (10 par défaut, de 2 à 300)

export interface WorkerConfig {
  r2: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
  ffmpegPath: string;
  pollSeconds: number;
}

export type WorkerConfigResult = { ok: true; config: WorkerConfig } | { ok: false; missing: string[] };

export const DEFAULT_BUCKET = "vynlmusic";

export function parseWorkerConfig(source: Record<string, string | undefined>, ffmpegStatic: string | null): WorkerConfigResult {
  const read = (name: string) => source[name]?.trim() || undefined;
  const accountId = read("R2_ACCOUNT_ID");
  const accessKeyId = read("R2_ACCESS_KEY_ID");
  const secretAccessKey = read("R2_SECRET_ACCESS_KEY");
  const ffmpegPath = read("FFMPEG_PATH") ?? ffmpegStatic ?? undefined;

  const missing: string[] = [];
  if (!accountId) missing.push("R2_ACCOUNT_ID");
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (!ffmpegPath) missing.push("FFMPEG_PATH");
  if (missing.length > 0 || !accountId || !accessKeyId || !secretAccessKey || !ffmpegPath) return { ok: false, missing };

  const poll = Number(read("TRANSCODE_POLL_SECONDS"));
  const pollSeconds = Number.isFinite(poll) && poll >= 2 && poll <= 300 ? Math.round(poll) : 10;
  return {
    ok: true,
    config: { r2: { accountId, accessKeyId, secretAccessKey, bucket: read("R2_BUCKET") ?? DEFAULT_BUCKET }, ffmpegPath, pollSeconds },
  };
}
