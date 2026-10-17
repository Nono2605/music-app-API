// Relecture du nom d'artiste (migration 20261017000000_artist_name_review.sql) : un nom proche d'un nom
// existant attend la décision de l'administration. Tant qu'elle n'est pas prise, la page de l'artiste n'est
// pas publique et aucune release ne peut être soumise ; un refus se corrige en choisissant un autre nom.
// Fonctions pures, testées avec `npm test`.

export type NameStatus = "approved" | "pending" | "rejected";

export function isNameStatus(value: unknown): value is NameStatus {
  return value === "approved" || value === "pending" || value === "rejected";
}

// Le statut d'un nom qu'on vient de choisir : proche d'un nom existant → l'administration tranche ;
// sinon il est accepté tout de suite (les contrôles automatiques ont déjà eu lieu).
export function statusForNewName(similarCount: number): NameStatus {
  return similarCount > 0 ? "pending" : "approved";
}

// Un nom accepté est permanent (il figure sur le catalogue, les relevés, les pages publiques) : seul un nom
// en attente ou refusé se change.
export function canRenameArtist(status: NameStatus): boolean {
  return status !== "approved";
}

// Avant la migration, les lignes n'ont ni statut ni motif : tous les noms comptent comme acceptés.
export function withNameReview<T extends Record<string, unknown>>(
  row: T
): T & { name_status: NameStatus; name_review_note: string | null } {
  return {
    ...row,
    name_status: isNameStatus(row.name_status) ? row.name_status : "approved",
    name_review_note: typeof row.name_review_note === "string" ? row.name_review_note : null,
  };
}

// Pourquoi cet artiste ne peut pas encore soumettre de musique, ou null s'il le peut.
export function nameReviewProblem(status: unknown, note?: unknown): string | null {
  if (status === "pending") {
    return "Your artist name is being reviewed by our team. You can submit your music for review once it is approved.";
  }
  if (status === "rejected") {
    const reason = typeof note === "string" ? note.trim().replace(/[.\s]+$/, "") : "";
    return `Your artist name was declined${reason ? `: ${reason}` : ""}. Choose another name on your Profile page, then submit again.`;
  }
  return null;
}
