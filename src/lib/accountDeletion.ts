// Suppression d'un compte par son propriétaire (droit à l'effacement). La base fait l'essentiel : supprimer
// l'utilisateur d'authentification supprime son compte et ses données personnelles (profil, bibliothèque,
// playlists, consentements…), détache l'historique d'écoute et les pièces comptables (user_id passe à null,
// elles sont conservées), et anonymise ses pages d'artiste (migration 20261011000000). Ici : les garde-fous
// et l'ordre des opérations.

export type DeletionCheck = { ok: true } | { ok: false; status: number; error: string; code: string };

// Taper son adresse e-mail pour confirmer (comme pour supprimer un dépôt) : un clic de travers ou une
// requête automatisée ne suffit pas. Les comptes administrateurs ne se suppriment pas ici.
export function checkDeletionRequest(user: { email: string | null; role: string }, body: unknown): DeletionCheck {
  if (user.role === "admin") {
    return { ok: false, status: 403, code: "admin_account", error: "Administrator accounts cannot be deleted here." };
  }
  const given = (body as { confirm_email?: unknown } | null | undefined)?.confirm_email;
  if (typeof given !== "string" || !user.email || given.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
    return { ok: false, status: 400, code: "confirmation_mismatch", error: "Type your account email address to confirm." };
  }
  return { ok: true };
}

export interface DeletionSteps {
  // Annule les abonnements encore actifs chez le prestataire de paiement ; rend leur nombre. Doit LEVER si
  // l'annulation échoue : on ne supprime pas un compte dont l'abonnement continuerait de prélever.
  cancelSubscriptions(userId: string): Promise<number>;
  // Supprime l'utilisateur d'authentification (et, par cascade, le compte).
  deleteAuthUser(userId: string): Promise<void>;
}

// L'ordre compte : d'abord arrêter ce qui est facturé, ensuite seulement supprimer. Si l'annulation échoue,
// rien n'est supprimé et l'utilisateur peut réessayer.
export async function performDeletion(userId: string, steps: DeletionSteps): Promise<{ subscriptionsCancelled: number }> {
  const subscriptionsCancelled = await steps.cancelSubscriptions(userId);
  await steps.deleteAuthUser(userId);
  return { subscriptionsCancelled };
}
