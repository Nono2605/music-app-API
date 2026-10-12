import type { NextFunction, Request, Response } from "express";
import { isBlockedStatus } from "../lib/accountStatus";
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

// Vérifie le JWT Supabase transmis par le client (web/mobile) et attache
// l'identité à req.auth. Ne charge pas le rôle applicatif ici : les routes
// qui en ont besoin le lisent dans public.users (une seule source de vérité).
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
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
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      authFailures.record(ip);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // Un compte suspendu ou supprimé depuis l'admin ne passe plus, même avec un
    // jeton encore valide (le bannissement Supabase Auth n'invalide pas un jeton
    // déjà émis, valable jusqu'à une heure). Voir lib/accountStatus.ts.
    if (isBlockedStatus(await loadAccountStatus(data.user.id))) {
      return res.status(403).json({ error: "Account is not active" });
    }

    req.auth = { id: data.user.id, email: data.user.email };
    next();
  } catch (err) {
    next(err);
  }
}
