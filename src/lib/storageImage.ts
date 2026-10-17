// Images envoyées par les créateurs dans le stockage public : pochettes de release (bucket
// `release-covers`) et photo / bannière d'artiste (bucket `artist-images`).
//
// Les routes qui enregistrent une URL (PATCH /creator/albums/:id, PATCH /creator/artist)
// recevraient sinon n'importe quelle chaîne du client : une image hébergée ailleurs (suivi des
// auditeurs, contenu modifiable après coup) ou un fichier d'un autre créateur. On n'accepte donc
// que les fichiers de NOS buckets, rangés sous le dossier de l'artiste connecté, nommés comme
// les produisent les routes d'envoi.

export const COVER_BUCKET = "release-covers";
export const ARTIST_IMAGE_BUCKET = "artist-images";

// Types acceptés → extension du fichier stocké.
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Anciens clients (avant ce contrôle) n'envoyaient que le nom du fichier : on en déduit le type.
const EXT_TYPES: Record<string, string> = { jpg: "jpg", jpeg: "jpg", png: "png", webp: "webp" };

export function imageExtension(contentType: unknown): string | null {
  return typeof contentType === "string" ? (IMAGE_TYPES[contentType.toLowerCase()] ?? null) : null;
}

// Extension normalisée d'un nom de fichier (« Photo.JPEG » → « jpg »), ou null si ce n'est pas
// une image acceptée.
export function extensionFromFilename(filename: unknown): string | null {
  if (typeof filename !== "string" || !filename.includes(".")) return null;
  return EXT_TYPES[(filename.split(".").pop() ?? "").toLowerCase()] ?? null;
}

export function coverPath(artistId: string, albumId: string, ext: string, now: number): string {
  return `${artistId}/${albumId}-${now}.${ext}`;
}

export type ArtistImageKind = "avatar" | "banner";
export const ARTIST_IMAGE_KINDS: ReadonlySet<string> = new Set<ArtistImageKind>(["avatar", "banner"]);

export function artistImagePath(artistId: string, kind: ArtistImageKind, ext: string, now: number): string {
  return `${artistId}/${kind}-${now}.${ext}`;
}

// Le nom de fichier n'a que des caractères sûrs : ni « .. », ni « / », ni paramètres d'URL.
const SAFE_FILE = /^[A-Za-z0-9-]+\.(jpg|png|webp)$/;

// `publicPrefix` : URL publique du dossier de l'artiste, avec « / » final
// (storage.from(bucket).getPublicUrl(`${artistId}/`)). Renvoie le chemin dans le bucket
// ("artistId/fichier.jpg") si l'URL est bien un fichier de cet artiste, sinon null.
// `namePrefix` : début imposé du nom de fichier (« avatar- », « banner- ») pour qu'une photo ne
// serve pas de bannière à la place de l'autre.
export function ownImagePath(
  url: unknown,
  publicPrefix: string,
  artistId: string,
  namePrefix = ""
): string | null {
  if (typeof url !== "string" || !publicPrefix.endsWith("/") || !url.startsWith(publicPrefix)) return null;
  const file = url.slice(publicPrefix.length);
  return SAFE_FILE.test(file) && file.startsWith(namePrefix) ? `${artistId}/${file}` : null;
}
