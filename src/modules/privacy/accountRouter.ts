import { Router, type RequestHandler, type Response } from "express";
import { checkDeletionRequest, performDeletion, type DeletionSteps } from "../../lib/accountDeletion";
import type { PrivacyRequestRecord } from "../../lib/privacyRequests";

// Export des données et suppression du compte par son propriétaire. Les dépendances sont injectées pour
// pouvoir tester le comportement sans base ni Stripe (account.ts branche les vraies).

export interface AccountDeps {
  authenticate: RequestHandler;
  loadUser(userId: string): Promise<{ email: string | null; role: string } | null>;
  exportAccount(userId: string, now: Date): Promise<Record<string, unknown>>;
  steps: DeletionSteps;
  record(record: PrivacyRequestRecord): Promise<void>;
  // Une erreur de la facturation (Stripe absent ou en échec) : la réponse à renvoyer, ou null si ce n'en est pas une.
  billingFailure(err: unknown): { status: number; body: { error: string; code: string } } | null;
  now?: () => Date;
}

export function createAccountRouter(deps: AccountDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  // GET /me/export — toutes les données du compte, en JSON, à télécharger.
  router.get("/me/export", deps.authenticate, async (req, res, next) => {
    try {
      const at = now();
      const data = await deps.exportAccount(req.auth!.id, at);
      await deps.record({ kind: "export", status: "completed", user_id: req.auth!.id });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="vynl-data-${at.toISOString().slice(0, 10)}.json"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(JSON.stringify(data, null, 2));
    } catch (err) {
      next(err);
    }
  });

  // POST /me/delete { confirm_email } — supprime le compte et ses données personnelles. Irréversible.
  router.post("/me/delete", deps.authenticate, async (req, res: Response, next) => {
    const userId = req.auth!.id;
    try {
      const user = await deps.loadUser(userId);
      if (!user) return res.status(404).json({ error: "Account not found" });

      const check = checkDeletionRequest(user, req.body);
      if (!check.ok) return res.status(check.status).json({ error: check.error, code: check.code });

      const { subscriptionsCancelled } = await performDeletion(userId, deps.steps);
      // Le compte n'existe plus : pas de user_id dans le registre.
      await deps.record({ kind: "deletion", status: "completed", user_id: null, detail: { subscriptions_cancelled: subscriptionsCancelled } });
      res.json({ deleted: true, subscriptions_cancelled: subscriptionsCancelled });
    } catch (err) {
      await deps.record({ kind: "deletion", status: "failed", user_id: userId });
      const billing = deps.billingFailure(err);
      if (billing) return res.status(billing.status).json(billing.body);
      next(err);
    }
  });

  return router;
}
