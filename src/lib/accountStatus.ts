// Statut d'un compte (public.users.status : active / suspended / deleted).
//
// Règle PURE (aucune base, aucune variable d'environnement) pour être testable
// seule ; le chargement du statut est dans loadAccountStatus.ts.

// Seul un compte « active » passe. Une ligne introuvable (null) n'est PAS
// bloquée : le trigger handle_new_auth_user crée la ligne à l'inscription, et
// un compte plus ancien sans ligne se comportait déjà ainsi — on ne l'enferme
// pas dehors d'un coup. Les routes qui ont besoin de la ligne répondent seules.
export function isBlockedStatus(status: string | null): boolean {
  return status !== null && status !== "active";
}

// Cache mémoire avec durée de vie : requireAuth tourne sur CHAQUE requête
// (dont les battements de cœur de lecture, toutes les quelques secondes par
// auditeur) ; sans cache, chacun ajouterait une lecture en base. Contrepartie :
// une suspension prend effet au plus tard après `ttlMs`. Le cache est par
// instance, l'admin tourne dans un autre processus : il ne peut pas l'invalider.
export function createStatusCache(
  load: (userId: string) => Promise<string | null>,
  ttlMs: number,
  now: () => number = Date.now,
  maxEntries = 5000
) {
  const entries = new Map<string, { status: string | null; expiresAt: number }>();

  return async function status(userId: string): Promise<string | null> {
    const at = now();
    const hit = entries.get(userId);
    if (hit && hit.expiresAt > at) return hit.status;

    // Une erreur de lecture remonte et n'est PAS mise en cache.
    const loaded = await load(userId);
    entries.set(userId, { status: loaded, expiresAt: at + ttlMs });

    if (entries.size > maxEntries) {
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= at) entries.delete(key);
      }
    }
    return loaded;
  };
}
