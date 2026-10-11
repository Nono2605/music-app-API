// Pochettes de release : quelles URLs le serveur accepte d'enregistrer dans albums.cover_url.
//
// PATCH /creator/albums/:id recevrait sinon n'importe quelle chaîne du client : une image
// hébergée ailleurs (suivi des auditeurs, contenu modifiable après coup) ou un fichier d'un
// autre créateur. On n'accepte donc que les fichiers du bucket `release-covers`, rangés sous
// le dossier de l'artiste connecté, nommés comme les produit /albums/:id/cover-upload-url.

export const COVER_BUCKET = "release-covers";

// Types acceptés → extension du fichier stocké.
const COVER_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function coverExtension(contentType: unknown): string | null {
  return typeof contentType === "string" ? (COVER_TYPES[contentType.toLowerCase()] ?? null) : null;
}

export function coverPath(artistId: string, albumId: string, ext: string, now: number): string {
  return `${artistId}/${albumId}-${now}.${ext}`;
}

// Le nom de fichier n'a que des caractères sûrs : ni « .. », ni « / », ni paramètres d'URL.
const SAFE_FILE = /^[A-Za-z0-9-]+\.(jpg|png|webp)$/;

// `publicPrefix` : URL publique du dossier de l'artiste, avec « / » final
// (storage.from(bucket).getPublicUrl(`${artistId}/`)). Renvoie le chemin dans le bucket
// ("artistId/fichier.jpg") si l'URL est bien un fichier de cet artiste, sinon null.
export function ownCoverPath(url: unknown, publicPrefix: string, artistId: string): string | null {
  if (typeof url !== "string" || !publicPrefix.endsWith("/") || !url.startsWith(publicPrefix)) return null;
  const file = url.slice(publicPrefix.length);
  return SAFE_FILE.test(file) ? `${artistId}/${file}` : null;
}
