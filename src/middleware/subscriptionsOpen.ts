import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";

// Les abonnements s'ouvrent APRÈS la bêta : tant que SUBSCRIPTIONS_OPEN n'est pas « yes », personne ne peut ouvrir une
// page de paiement, même en appelant l'API directement (cacher le bouton de l'app ne suffit pas). Passe avant la vérification
// du jeton : une demande refusée ne coûte aucun appel à Supabase.
export const SUBSCRIPTIONS_CLOSED = {
  error: "Subscriptions will be available after the beta.",
  code: "subscriptions_closed",
} as const;

export function createRequireSubscriptionsOpen(isOpen: () => boolean) {
  return function requireSubscriptionsOpen(_req: Request, res: Response, next: NextFunction) {
    if (!isOpen()) return res.status(403).json(SUBSCRIPTIONS_CLOSED);
    next();
  };
}

export const requireSubscriptionsOpen = createRequireSubscriptionsOpen(() => env.subscriptionsOpen);
