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
  // Vie privée (lib/consents.ts) : âge minimum (16 par défaut) et finalités facultatives
  // à demander (aucune par défaut : on ne demande rien d'inutile).
  privacy: parsePrivacyConfig(process.env.PRIVACY_MIN_AGE, process.env.PRIVACY_OPTIONAL_PURPOSES),
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};
