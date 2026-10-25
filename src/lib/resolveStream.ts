// Quelle adresse d'écoute donner pour un morceau : celle du CDN si une version AAC est prête, sinon celle du fichier
// original dans Supabase. Pure (les accès à la base et à Supabase sont injectés) pour être testable seule.
//
// Règle d'or : le CDN ne doit JAMAIS empêcher d'écouter. Une panne en le cherchant (table absente avant la migration,
// base lente, clé de stockage invalide) retombe sur Supabase, et l'erreur est seulement signalée.
import { signCdnUrl, type CdnConfig } from "./cdnToken";
import { pickRendition, type Rendition, type StreamQuality } from "./renditions";

// Durée de vie d'une adresse d'écoute, la même pour le CDN et pour Supabase.
export const STREAM_URL_SECONDS = 60 * 60 * 6;

export interface SourceFile {
  id: string;
  storage_key: string;
  format: string;
}

export interface StreamDeps {
  /** Le fichier original servi aujourd'hui : le plus ancien du morceau. `null` s'il n'a aucun fichier. */
  loadSourceFile(trackId: string): Promise<SourceFile | null>;
  /** Les versions AAC prêtes de CE fichier. */
  loadRenditions(sourceFileId: string): Promise<Rendition[]>;
  /** L'adresse signée du fichier original chez Supabase. */
  signOriginal(file: SourceFile): Promise<string>;
  nowSeconds(): number;
  onCdnError(err: unknown): void;
}

export interface ResolvedStream {
  url: string;
  format: string;
  delivery: "cdn" | "supabase";
}

export async function resolveStream(
  deps: StreamDeps,
  cdn: CdnConfig | undefined,
  trackId: string,
  quality: StreamQuality
): Promise<ResolvedStream | null> {
  const file = await deps.loadSourceFile(trackId);
  if (!file) return null;

  if (cdn) {
    try {
      const rendition = pickRendition(await deps.loadRenditions(file.id), quality);
      if (rendition) {
        const url = signCdnUrl(cdn.baseUrl, rendition.storage_key, cdn.secret, deps.nowSeconds() + STREAM_URL_SECONDS);
        return { url, format: "m4a", delivery: "cdn" };
      }
    } catch (err) {
      deps.onCdnError(err);
    }
  }

  return { url: await deps.signOriginal(file), format: file.format, delivery: "supabase" };
}
