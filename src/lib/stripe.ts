import Stripe from "stripe";
import { env } from "../config/env";
import { stripeKeyMode, stripeKeyProblem, type StripeMode } from "./stripeKey";

// Le client Stripe de l'API. Aucune clé n'est jamais écrite dans le code : elle vient de
// STRIPE_SECRET_KEY (variable d'environnement de Render), et une clé « live » est refusée
// tant que STRIPE_ALLOW_LIVE n'est pas « yes » (voir lib/stripeKey.ts).

export class StripeNotConfiguredError extends Error {}

// Pourquoi Stripe n'est pas utilisable ici, ou null.
export function stripeProblem(): string | null {
  return stripeKeyProblem(env.stripeSecretKey, env.stripeAllowLive);
}

export function stripeMode(): StripeMode | null {
  return stripeKeyMode(env.stripeSecretKey);
}

let client: Stripe | undefined;

export function getStripe(): Stripe {
  const problem = stripeProblem();
  if (problem) throw new StripeNotConfiguredError(problem);

  // Délai court et une seule nouvelle tentative : une requête de l'API ne doit pas
  // attendre Stripe indéfiniment.
  client ??= new Stripe(env.stripeSecretKey!, {
    timeout: 10_000,
    maxNetworkRetries: 1,
    appInfo: { name: "Vynl API" },
  });
  return client;
}
