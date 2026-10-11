// Quelle clé Stripe l'API a-t-elle reçue, et peut-on s'en servir ici ?
//
// Règle PURE (aucune base, aucune variable d'environnement, aucun appel Stripe) pour être
// testable seule. Principe : pendant le développement l'API n'accepte QUE des clés de TEST ;
// une clé « live » est refusée tant qu'on n'a pas dit explicitement (STRIPE_ALLOW_LIVE=yes) que
// l'on est en production. Aucun message ne reprend la clé : un message d'erreur finit dans un
// journal ou à l'écran.

export type StripeMode = "test" | "live";

const SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;

// « test » ou « live » d'après le préfixe d'une clé secrète (sk_…) ou restreinte (rk_…) ;
// null si ce n'est pas une clé de ce genre.
export function stripeKeyMode(key: string | undefined): StripeMode | null {
  const match = key ? SECRET_KEY.exec(key) : null;
  return match ? (match[2] as StripeMode) : null;
}

// Pourquoi cette clé est inutilisable, ou null si on peut s'en servir.
export function stripeKeyProblem(key: string | undefined, allowLive: boolean): string | null {
  if (!key) return "STRIPE_SECRET_KEY is not set.";
  // Erreur classique : coller la clé PUBLIABLE (pk_…) à la place de la clé secrète.
  if (key.startsWith("pk_")) return "STRIPE_SECRET_KEY holds a publishable key (pk_…). The API needs the secret key (sk_test_…).";

  const mode = stripeKeyMode(key);
  if (!mode) return "STRIPE_SECRET_KEY is not a Stripe secret key (it should start with sk_test_).";
  if (mode === "live" && !allowLive) {
    return "Refusing a LIVE Stripe key: this API is still in development. Use a test key (sk_test_…). STRIPE_ALLOW_LIVE=yes is for launch only.";
  }
  return null;
}
