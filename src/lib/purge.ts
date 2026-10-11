// Logique pure de la purge des fichiers d'un artiste anonymisé (script
// scripts/purgeAnonymized.ts). Rien ici n'accède à la base ni au stockage.

export interface PurgeCandidate {
  anonymized_at: string | null;
  purge_after: string | null;
  purged_at: string | null;
  legal_hold: boolean | null;
}

// Un artiste est à purger quand il est anonymisé, que son délai de grâce est écoulé,
// qu'il n'a pas déjà été purgé et qu'aucun gel légal ne le retient. Les dates absentes
// ou illisibles ne déclenchent JAMAIS de purge : dans le doute, on ne supprime pas.
export function isPurgeDue(artist: PurgeCandidate, now: Date): boolean {
  if (artist.legal_hold) return false;
  if (!artist.anonymized_at || artist.purged_at) return false;
  if (!artist.purge_after) return false;
  const due = Date.parse(artist.purge_after);
  if (Number.isNaN(due)) return false;
  return due <= now.getTime();
}

// Découpe une liste en lots (le stockage limite le nombre d'objets par suppression).
export function chunk<T>(items: T[], size: number): T[][] {
  if (!(size >= 1)) throw new Error("chunk size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
