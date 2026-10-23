// Identification d'un jeton d'accès Supabase, avec ou sans appel à Supabase Auth.
//
// Par défaut (et en cas de doute), chaque requête demande à Supabase Auth « à qui est ce jeton ? »
// (getUser) : un aller-retour réseau par requête, y compris par battement de lecture. Avec la
// vérification locale, la signature du jeton se contrôle avec la clé PUBLIQUE du projet (relue toutes les
// dix minutes par supabase-js) et la requête ne fait plus d'appel réseau.
//
// Règles de prudence :
//  * la vérification locale n'ACCEPTE que si tout est bon : signature, expiration, émetteur, audience,
//    rôle « authenticated » et utilisateur présent. La clé « anon » du projet est un jeton valide signé
//    par le même projet : sans ces contrôles, elle passerait ;
//  * un jeton dont la signature est bonne mais dont le contenu est refusé n'est pas rejeté ici : c'est
//    Supabase Auth qui tranche, comme avant ;
//  * un jeton que la bibliothèque déclare invalide (signature, expiration, forme) est rejeté sans appel
//    réseau ; une panne (réseau, erreur 5xx, limite de débit) bascule sur Supabase Auth.
//
// Fonctions sans base ni variable d'environnement, testables seules ; le câblage est dans middleware/auth.ts.

export interface Identity {
  id: string;
  email: string | undefined;
}

// Ce que rend la vérification locale : les claims d'un jeton à la signature valide, ou l'erreur de la bibliothèque.
export type LocalResult = { claims: unknown } | { error: unknown };

export interface AuthenticateDeps {
  // null : vérification locale éteinte (comportement d'avant).
  local: ((token: string) => Promise<LocalResult>) | null;
  // Supabase Auth, qui fait foi : null si le jeton est refusé.
  service: (token: string) => Promise<Identity | null>;
  // Émetteur attendu : « <SUPABASE_URL>/auth/v1 ».
  issuer: string;
  nowSeconds?: () => number;
}

const AUDIENCE = "authenticated";

// Contrôle le CONTENU d'un jeton dont la signature et l'expiration viennent d'être vérifiées.
export function identityFromClaims(claims: unknown, issuer: string, nowSeconds: number): Identity | null {
  if (typeof claims !== "object" || claims === null) return null;
  const c = claims as Record<string, unknown>;

  if (c.iss !== issuer) return null;
  const audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!audiences.includes(AUDIENCE)) return null;
  if (c.role !== AUDIENCE) return null;
  if (typeof c.sub !== "string" || c.sub.length === 0) return null;
  if (typeof c.exp !== "number" || c.exp <= nowSeconds) return null;

  return { id: c.sub, email: typeof c.email === "string" && c.email !== "" ? c.email : undefined };
}

// Une erreur de vérification vient-elle d'un jeton mauvais (on le refuse) ou d'une panne (on demande à Supabase) ?
// AuthInvalidJwtError : signature fausse, jeton expiré ou mal formé. Un statut 4xx d'un appel à Supabase Auth
// est un refus, sauf 429 (limite de débit) ; tout le reste (réseau, 5xx, inconnu) est une panne.
export function classifyAuthError(error: unknown): "invalid" | "unavailable" {
  const e = (typeof error === "object" && error !== null ? error : {}) as { name?: unknown; status?: unknown };
  if (e.name === "AuthInvalidJwtError") return "invalid";
  const status = typeof e.status === "number" ? e.status : 0;
  return status >= 400 && status < 500 && status !== 429 ? "invalid" : "unavailable";
}

// Un JWT a trois morceaux en base64url dont les deux premiers sont des objets JSON. Sert à écarter tout de suite un
// jeton forgé ou tronqué, sans appel réseau (la signature, elle, se contrôle ensuite).
export function isWellFormedJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    for (const part of parts.slice(0, 2)) {
      const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Rend l'identité du jeton, ou null s'il est refusé.
export async function authenticateToken(token: string, deps: AuthenticateDeps): Promise<Identity | null> {
  if (deps.local) {
    // Un jeton qui n'a pas la forme d'un JWT (vide, tronqué, forgé) est refusé tout de suite, sans appel réseau.
    if (!isWellFormedJwt(token)) return null;

    let result: LocalResult | null = null;
    try {
      result = await deps.local(token);
    } catch (err) {
      // Un contenu qui n'est pas du JSON : jeton forgé, inutile d'interroger Supabase. Toute autre exception
      // est une panne : Supabase Auth tranche.
      if (err instanceof SyntaxError) return null;
    }

    if (result && "claims" in result) {
      const now = (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
      const identity = identityFromClaims(result.claims, deps.issuer, now);
      if (identity) return identity;
    } else if (result && classifyAuthError(result.error) === "invalid") {
      return null;
    }
  }

  return deps.service(token);
}
