import { createHash, timingSafeEqual } from "node:crypto";

// Authentification de NOTRE app auditeur auprès de l'API (secret partagé, en-tête x-vynl-webapp-secret).
//
// Pourquoi : l'app auditeur appelle l'API depuis son serveur et lui transmet le pays, l'appareil et
// l'IP du visiteur sous des en-têtes x-vynl-client-* (lib/clientInfo.ts). N'importe quel compte qui
// appelle l'API directement pourrait inventer ces valeurs pour ses propres écoutes. Avec le secret,
// l'API ne les croit que si la requête vient de l'app auditeur ; sinon elle les ignore (pays, appareil
// et empreinte restent vides). C'est un préalable pour répartir un jour un revenu publicitaire par pays.
//
// Trois états :
//  - « unconfigured » : aucun secret n'est défini sur l'API (cas d'avant) : comportement inchangé ;
//  - « trusted »      : un secret est défini et la requête le présente ;
//  - « untrusted »    : un secret est défini et la requête ne le présente pas (ou un faux).
//
// Mise en place : mettre le même secret (32 caractères au hasard ou plus) sur Vercel (app auditeur,
// variable WEBAPP_SHARED_SECRET), PUIS sur Render (API, même nom). Dans cet ordre : tant que l'API n'a
// pas de secret, rien ne change ; l'inverse ferait ignorer pays et appareil le temps du déploiement.

export const WEBAPP_SECRET_HEADER = "x-vynl-webapp-secret";

export type WebappTrust = "trusted" | "untrusted" | "unconfigured";

type HeaderValue = string | string[] | undefined;

// Comparaison à temps constant : on compare les empreintes (de même longueur), jamais les chaînes brutes.
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function webappTrust(headers: Record<string, HeaderValue>, secret: string | undefined): WebappTrust {
  if (!secret) return "unconfigured";
  const raw = headers[WEBAPP_SECRET_HEADER];
  const given = Array.isArray(raw) ? raw[0] : raw;
  if (!given) return "untrusted";
  return sameSecret(given, secret) ? "trusted" : "untrusted";
}

// Les en-têtes dont on peut tirer pays, appareil et IP : tous si la requête est de confiance (ou si aucun
// secret n'est défini), aucun sinon.
export function clientHeadersFor<T extends Record<string, HeaderValue>>(headers: T, secret: string | undefined): T | Record<string, never> {
  return webappTrust(headers, secret) === "untrusted" ? {} : headers;
}
