// Les versions AAC d'un morceau (table track_renditions) et le choix de celle qu'on sert.
//
// Deux qualités au choix de l'auditeur : « standard » (128 kbit/s, économe en données) et « high » (256 kbit/s).
// Si la version voulue n'existe pas (encore), on sert la plus proche : jamais de refus tant qu'une version existe.

export type StreamQuality = "standard" | "high";

export const QUALITY_KBPS: Record<StreamQuality, number> = { standard: 128, high: 256 };

export const DEFAULT_QUALITY: StreamQuality = "standard";

export function isStreamQuality(value: unknown): value is StreamQuality {
  return value === "standard" || value === "high";
}

export interface Rendition {
  storage_key: string;
  bitrate_kbps: number;
}

// Le débit le plus proche de celui voulu ; à égalité, le plus petit (moins de données pour l'auditeur).
export function pickRendition<T extends Rendition>(renditions: T[], quality: StreamQuality): T | null {
  const wanted = QUALITY_KBPS[quality];
  let best: T | null = null;
  for (const candidate of renditions) {
    if (!best) {
      best = candidate;
      continue;
    }
    const gap = Math.abs(candidate.bitrate_kbps - wanted);
    const bestGap = Math.abs(best.bitrate_kbps - wanted);
    if (gap < bestGap || (gap === bestGap && candidate.bitrate_kbps < best.bitrate_kbps)) best = candidate;
  }
  return best;
}

// Clé d'une version dans le bucket R2 : « t/<morceau>/<fichier>-<débit>.m4a ». Le morceau en tête de chemin
// regroupe ses fichiers ; la clé ne change jamais pour un fichier donné (le CDN les garde un an, immuables).
export function renditionKey(trackId: string, sourceFileId: string, bitrateKbps: number): string {
  return `t/${trackId}/${sourceFileId}-${bitrateKbps}.m4a`;
}
