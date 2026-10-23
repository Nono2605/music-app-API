import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { isBlockedStatus } from "../lib/accountStatus";
import { authenticateToken, type Identity, type LocalResult } from "../lib/accessToken";
import { authFailures } from "../lib/authFailures";
import { clientIp } from "../lib/rateLimit";
import { loadAccountStatus } from "../lib/loadAccountStatus";
import { supabaseAdmin } from "../lib/supabaseAdmin";

export interface AuthContext {
  id: string;
  email: string | undefined;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

// Émetteur des jetons du projet (claim `iss`) : « <SUPABASE_URL>/auth/v1 ».
const TOKEN_ISSUER = `${env.supabaseUrl.replace(/\/+$/, "")}/auth/v1`;

// Supabase Auth fait foi : un aller-retour réseau pour savoir à qui est ce jeton.
async function identifyWithSupabaseAuth(token: string): Promise<Identity | null> {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  return error || !data.user ? null : { id: data.user.id, email: data.user.email };
}

// Vérification locale (voir lib/accessToken.ts) : la signature se contrôle avec la clé publique du projet,
// sans appel réseau (supabase-js relit la clé toutes les dix minutes).
async function verifyClaimsLocally(token: string): Promise<LocalResult> {
  const { data, error } = await supabaseAdmin.auth.getClaims(token);
  return error || !data ? { error } : { claims: data.claims };
}

// Fabrique le middleware. `allowLocal` : peut-on se passer de Supabase Auth ? Seulement si AUTH_LOCAL_VERIFY est
// « on » : sans l'interrupteur, rien ne change.
function createRequireAuth(allowLocal: boolean) {
  const local = allowLocal && env.authLocalVerify ? verifyClaimsLocally : null;

  return async function requireAuth(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

    if (!token) {
      return res.status(401).json({ error: "Missing bearer token" });
    }

    // Trop de jetons refusés depuis cette adresse : on s'arrête avant d'interroger Supabase Auth
    // (voir lib/authFailures.ts : seuls les jetons REFUSÉS comptent).
    const ip = clientIp(req);
    if (authFailures.blocked(ip)) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "Too many failed attempts. Please try again later.", code: "rate_limited" });
    }

    // try/catch nécessaire : un rejet réseau/timeout ici (pas une simple erreur
    // Supabase Auth) est une Promise rejetée non catchée par Express 4 dans un
    // middleware async — elle ne passerait jamais par errorHandler sans ça,
    // et le client reçoit une réponse brute sans JSON exploitable.
    try {
      const identity = await authenticateToken(token, { local, service: identifyWithSupabaseAuth, issuer: TOKEN_ISSUER });
      if (!identity) {
        authFailures.record(ip);
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      // Un compte suspendu ou supprimé depuis l'admin ne passe plus, même avec un
      // jeton encore valide (le bannissement Supabase Auth n'invalide pas un jeton
      // déjà émis, valable jusqu'à une heure). Voir lib/accountStatus.ts.
      if (isBlockedStatus(await loadAccountStatus(identity.id))) {
        return res.status(403).json({ error: "Account is not active" });
      }

      req.auth = { id: identity.id, email: identity.email };
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Vérifie le JWT Supabase transmis par le client (web/mobile) et attache
// l'identité à req.auth. Ne charge pas le rôle applicatif ici : les routes
// qui en ont besoin le lisent dans public.users (une seule source de vérité).
// Avec AUTH_LOCAL_VERIFY=on, la signature est contrôlée localement (pas d'appel à Supabase Auth par requête).
export const requireAuth = createRequireAuth(true);

// Même contrôle, mais Supabase Auth est TOUJOURS interrogé : une déconnexion ou un compte supprimé y est vu
// tout de suite, alors qu'un jeton vérifié localement reste accepté jusqu'à son expiration (une heure au plus).
// Pour les routes sensibles : suppression et export de compte, paiement, administration.
export const requireAuthStrict = createRequireAuth(false);
