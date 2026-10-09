export interface FileDuration {
  created_at: string;
  duration_seconds: number | null;
}

/**
 * Durée que doit avoir un morceau d'après ses fichiers : celle du plus ancien,
 * qui est le fichier réellement streamé (GET /tracks/:id/stream trie par
 * created_at croissant).
 *
 * - `null` : plus aucun fichier, la durée n'a plus de support.
 * - un nombre : la durée mesurée du plus ancien.
 * - `undefined` : le plus ancien n'a jamais été mesuré (fichier antérieur à la
 *   mesure automatique) ; on ne sait pas, donc on ne change rien plutôt que
 *   d'effacer une durée existante.
 */
export function pickTrackDuration(files: FileDuration[]): number | null | undefined {
  if (files.length === 0) return null;
  const oldest = [...files].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))[0];
  return oldest.duration_seconds === null ? undefined : oldest.duration_seconds;
}
