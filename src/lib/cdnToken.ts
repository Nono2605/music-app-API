// Adresses signées du CDN audio (cdn.vynl.li). L'API signe, le Worker Cloudflare (cdn-worker/) vérifie : les mêmes
// règles des deux côtés, avec les mêmes vecteurs de test (cdn-worker/test/token.test.js).
//
//   https://cdn.vynl.li/<clé>?e=<expiration, secondes Unix>&s=<signature>
//   signature = base64url( HMAC-SHA256( secret, "<clé>\n<expiration>" ) )
//
// La signature couvre la clé du fichier ET l'expiration : une adresse ne sert que pour CE fichier, jusqu'à CETTE
// heure. Comme les adresses Supabase d'aujourd'hui, quiconque la possède peut l'utiliser jusqu'à son expiration.
import { createHmac } from "node:crypto";

// Une clé de fichier : des segments de lettres, chiffres, « . _ - » séparés par « / », sans « .. » ni « / » initial.
export function isSafeCdnKey(key: string): boolean {
  if (key.length === 0 || key.length > 300) return false;
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(key)) return false;
  return !key.split("/").some((part) => part === "." || part === "..");
}

export function cdnSignature(secret: string, key: string, expires: number): string {
  return createHmac("sha256", secret).update(`${key}\n${expires}`).digest("base64url");
}

// `base` : « https://cdn.vynl.li » (sans « / » final obligatoire). `expires` : secondes Unix.
export function signCdnUrl(base: string, key: string, secret: string, expires: number): string {
  if (!isSafeCdnKey(key)) throw new Error("Unsafe CDN key");
  return `${base.replace(/\/+$/, "")}/${key}?e=${expires}&s=${cdnSignature(secret, key, expires)}`;
}

export interface CdnConfig {
  baseUrl: string;
  secret: string;
}

// Les deux variables d'environnement du CDN (CDN_BASE_URL et CDN_TOKEN_SECRET). Il faut LES DEUX, et une adresse
// en https (http seulement vers la machine locale) : sinon le CDN reste éteint et l'écoute passe par Supabase,
// comme avant. Seule l'origine est gardée (« https://cdn.vynl.li »), jamais un chemin.
export function parseCdnConfig(baseUrl: string | undefined, secret: string | undefined): CdnConfig | undefined {
  const cleanSecret = secret?.trim();
  const cleanBase = baseUrl?.trim();
  if (!cleanSecret || !cleanBase) return undefined;
  let url: URL;
  try {
    url = new URL(cleanBase);
  } catch {
    return undefined;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
  return { baseUrl: url.origin, secret: cleanSecret };
}
