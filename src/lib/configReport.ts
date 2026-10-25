// Rapport de configuration de l'API pour la page « System » de l'admin : ce qui est réglé, jamais la valeur d'un secret.
//
// Pure (aucune variable d'environnement lue ici) pour être testable seule. Règle : un secret n'apparaît que sous la
// forme « réglé : oui / non » ; une adresse n'apparaît que par son nom d'hôte.

export interface ConfigInput {
  entitlementMode: "beta" | "live";
  authLocalVerify: boolean;
  ipHashSecret?: string;
  webappSharedSecret?: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripeAllowLive: boolean;
  stripeAutomaticTax: boolean;
  checkoutReturnBaseUrl?: string;
  // CDN audio : les deux valeurs brutes, et ce qu'en a retenu l'API (undefined si l'une manque ou si l'adresse est invalide).
  cdnBaseUrl?: string;
  cdnTokenSecret?: string;
  cdn?: { baseUrl: string };
  corsAllowedOrigins: string[];
}

export interface RuntimeInput {
  // Identifiant du commit déployé (Render le fournit dans RENDER_GIT_COMMIT).
  commit?: string;
  nodeVersion: string;
  uptimeSeconds: number;
}

export interface ConfigReport {
  deploy: { commit: string | null; node: string; uptime_seconds: number };
  entitlement_mode: "beta" | "live";
  auth_local_verify: boolean;
  secrets: {
    ip_hash_secret: boolean;
    webapp_shared_secret: boolean;
    stripe_secret_key: boolean;
    stripe_webhook_secret: boolean;
    cdn_token_secret: boolean;
  };
  stripe: { mode: "test" | "live" | null; allow_live: boolean; automatic_tax: boolean };
  checkout_return_host: string | null;
  // `active` : l'API sert l'écoute par le CDN (adresse valide ET secret réglé). `configured_host` : l'adresse demandée, même invalide.
  cdn: { active: boolean; host: string | null; configured_host: string | null };
  cors_allowed_origins: string[];
}

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function stripeMode(key: string | undefined): "test" | "live" | null {
  if (!key) return null;
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  return null;
}

export function buildConfigReport(config: ConfigInput, runtime: RuntimeInput): ConfigReport {
  return {
    deploy: {
      commit: runtime.commit ? runtime.commit.slice(0, 7) : null,
      node: runtime.nodeVersion,
      uptime_seconds: Math.max(0, Math.round(runtime.uptimeSeconds)),
    },
    entitlement_mode: config.entitlementMode,
    auth_local_verify: config.authLocalVerify,
    secrets: {
      ip_hash_secret: Boolean(config.ipHashSecret),
      webapp_shared_secret: Boolean(config.webappSharedSecret),
      stripe_secret_key: Boolean(config.stripeSecretKey),
      stripe_webhook_secret: Boolean(config.stripeWebhookSecret),
      cdn_token_secret: Boolean(config.cdnTokenSecret),
    },
    stripe: {
      mode: stripeMode(config.stripeSecretKey),
      allow_live: config.stripeAllowLive,
      automatic_tax: config.stripeAutomaticTax,
    },
    checkout_return_host: hostOf(config.checkoutReturnBaseUrl),
    cdn: { active: Boolean(config.cdn), host: hostOf(config.cdn?.baseUrl), configured_host: hostOf(config.cdnBaseUrl) },
    cors_allowed_origins: [...config.corsAllowedOrigins],
  };
}
