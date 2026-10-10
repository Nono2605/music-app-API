import { createHmac } from "node:crypto";

// Pays, appareil et empreinte d'IP d'une lecture (colonnes plays.country_code,
// device_type, ip_hash ; docs/SPEC_REMUNERATION.md §6.2 et §6.3).
//
// La webapp appelle l'API depuis SON serveur : l'adresse vue ici est celle de la
// webapp, pas celle de l'auditeur. La webapp transmet donc les en-têtes du visiteur
// sous des noms à elle (x-vynl-client-*), et c'est d'eux qu'on tire les valeurs.
//
// Limite assumée : ces en-têtes sont DÉCLARÉS par l'appelant, l'API ne peut pas les
// vérifier (un compte qui appellerait l'API directement pourrait en mentir pour ses
// propres lectures). Acceptable pour des statistiques. Avant de répartir un revenu
// publicitaire par pays (D9), il faudra authentifier la webapp (secret partagé).
//
// Données minimales : jamais l'IP elle-même, seulement une empreinte salée dont le
// sel change chaque jour (pas de suivi d'une personne d'un jour à l'autre, mais le
// même visiteur reste reconnaissable dans la journée pour l'analyse de fraude).

export const CLIENT_COUNTRY_HEADER = "x-vynl-client-country";
export const CLIENT_UA_HEADER = "x-vynl-client-ua";
export const CLIENT_IP_HEADER = "x-vynl-client-ip";

export type DeviceType = "mobile" | "tablet" | "desktop";

export interface ClientInfo {
  country_code: string | null;
  device_type: DeviceType | null;
  ip_hash: string | null;
}

type HeaderValue = string | string[] | undefined;

function first(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ISO 3166-1 alpha-2. « XX » (inconnu) et « T1 » (Tor, chez certains fournisseurs)
// ne sont pas des pays : mieux vaut « inconnu » qu'un faux pays.
export function parseCountry(raw: HeaderValue): string | null {
  const value = first(raw)?.trim().toUpperCase();
  if (!value || !/^[A-Z]{2}$/.test(value)) return null;
  return value === "XX" || value === "T1" ? null : value;
}

// Classement volontairement grossier (trois valeurs) : assez pour « mobile ou
// ordinateur », sans prétendre à une précision qu'un user-agent ne donne pas.
export function parseDevice(raw: HeaderValue): DeviceType | null {
  const ua = first(raw)?.trim().slice(0, 512);
  if (!ua) return null;
  if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return "tablet";
  if (/mobi|iphone|ipod|android|windows phone/i.test(ua)) return "mobile";
  return "desktop";
}

// L'IP n'est jamais stockée : seulement HMAC-SHA256(secret, « jour|ip »), tronqué.
// Sans secret configuré, pas d'empreinte (null) plutôt qu'un hash non salé, qui se
// retrouverait par simple énumération des adresses IPv4.
export function hashIp(raw: HeaderValue, secret: string | undefined, now: Date): string | null {
  const ip = first(raw)?.trim();
  if (!secret || !ip || ip.length > 45 || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  const day = now.toISOString().slice(0, 10);
  return createHmac("sha256", secret).update(`${day}|${ip}`).digest("hex").slice(0, 32);
}

export function parseClientInfo(
  headers: Record<string, HeaderValue>,
  opts: { ipHashSecret: string | undefined; now: Date }
): ClientInfo {
  return {
    country_code: parseCountry(headers[CLIENT_COUNTRY_HEADER]),
    device_type: parseDevice(headers[CLIENT_UA_HEADER]),
    ip_hash: hashIp(headers[CLIENT_IP_HEADER], opts.ipHashSecret, opts.now),
  };
}
