import "dotenv/config";
import { parsePrivacyConfig } from "../lib/consents";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Supabase a remplacé service_role par une clé "secret" (nouveau système de
// clés API). On prend SUPABASE_SECRET_KEY en priorité, avec repli sur
// l'ancien nom pour les projets qui n'ont pas encore migré.
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseSecretKey) {
  throw new Error("Missing required environment variable: SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)");
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseSecretKey,
  // « beta » (par défaut, et en cas de doute) : toute lecture est enregistrée mais
  // sans revenu. « live » : le droit d'écoute vient de l'abonnement de l'utilisateur
  // (voir lib/entitlement.ts). À ne passer à « live » qu'à la fin de la bêta.
  entitlementMode: (process.env.ENTITLEMENT_MODE === "live" ? "live" : "beta") as "beta" | "live",
  // Secret qui sale l'empreinte d'IP des lectures (lib/clientInfo.ts). Facultatif :
  // sans lui, plays.ip_hash reste vide (jamais d'empreinte non salée).
  ipHashSecret: process.env.IP_HASH_SECRET || undefined,
  // Secret partagé avec l'app auditeur (lib/webappAuth.ts). Facultatif : sans lui, les en-têtes de pays,
  // d'appareil et d'IP envoyés par n'importe quel appelant sont crus (comportement d'avant).
  webappSharedSecret: process.env.WEBAPP_SHARED_SECRET?.trim() || undefined,
  // Stripe (lib/stripe.ts). La clé vient UNIQUEMENT de l'environnement (Render), jamais du
  // code ni d'un dépôt. Une clé « live » est refusée tant que STRIPE_ALLOW_LIVE n'est pas « yes ».
  stripeSecretKey: process.env.STRIPE_SECRET_KEY?.trim() || undefined,
  stripeAllowLive: process.env.STRIPE_ALLOW_LIVE === "yes",
  // Secret de signature des webhooks (« whsec_… », Stripe > Developers > Webhooks). Sans lui,
  // l'API refuse toute livraison d'événement (503) : jamais d'événement non vérifié.
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined,
  // Calcul automatique de la taxe par Stripe Tax : « on » seulement une fois Stripe Tax réglé
  // (adresse de l'entreprise, pays d'enregistrement), sinon la création du paiement échoue.
  stripeAutomaticTax: process.env.STRIPE_AUTOMATIC_TAX === "on",
  // Adresse de l'app auditeur (retour de Stripe Checkout et du portail client).
  checkoutReturnBaseUrl: process.env.CHECKOUT_RETURN_BASE_URL?.trim() || undefined,
  // « on » : le jeton d'accès se vérifie localement (signature, clé publique du projet) au lieu d'un appel à
  // Supabase Auth par requête (middleware/auth.ts, lib/accessToken.ts). Toute autre valeur : comportement d'avant.
  authLocalVerify: process.env.AUTH_LOCAL_VERIFY === "on",
  // Vie privée (lib/consents.ts) : âge minimum (16 par défaut) et finalités facultatives
  // à demander (aucune par défaut : on ne demande rien d'inutile).
  privacy: parsePrivacyConfig(process.env.PRIVACY_MIN_AGE, process.env.PRIVACY_OPTIONAL_PURPOSES),
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};
