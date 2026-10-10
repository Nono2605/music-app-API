// À quel titre une lecture a lieu (spec : décision D12). Figé dans la lecture au
// moment où elle commence : on ne peut pas le reconstituer plus tard.
//
// Règle PURE (aucune base, aucune variable d'environnement) pour être testable
// seule ; le chargement de l'abonnement est dans loadEntitlement.ts.
export type Entitlement = "beta" | "subscriber" | "free_ad_supported" | "trial";
export type EntitlementMode = "beta" | "live";

export interface SubscriptionRow {
  status: string;
  current_period_end: string | null;
}

/**
 * - mode `beta` (par défaut) : toute lecture vaut `beta`, aucun revenu.
 * - mode `live` : abonnement actif -> `subscriber`, essai en cours -> `trial`,
 *   sinon `free_ad_supported`. Une période échue ne donne aucun droit payant.
 */
export function resolveEntitlement(
  mode: EntitlementMode,
  subscription: SubscriptionRow | null,
  now: Date
): Entitlement {
  if (mode === "beta") return "beta";
  if (!subscription) return "free_ad_supported";

  const inPeriod = subscription.current_period_end === null || Date.parse(subscription.current_period_end) > now.getTime();
  if (inPeriod && subscription.status === "active") return "subscriber";
  if (inPeriod && subscription.status === "trialing") return "trial";
  return "free_ad_supported";
}
