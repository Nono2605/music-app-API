import { Router } from "express";
import { env } from "../../config/env";
import { buildConfigReport } from "../../lib/configReport";
import { requireAuthStrict } from "../../middleware/auth";
import { requireAdmin } from "../../middleware/requireAdmin";

export const adminRouter = Router();

// GET /admin/config — ce qui est réglé sur cette API (modes, secrets réglés oui / non, version déployée). RÉSERVÉ AUX
// ADMINS. Ne renvoie jamais la valeur d'un secret : voir lib/configReport.ts. Sert à la page « System » de l'admin.
adminRouter.get("/config", requireAuthStrict, requireAdmin, (_req, res) => {
  res.json(
    buildConfigReport(env, {
      commit: process.env.RENDER_GIT_COMMIT,
      nodeVersion: process.version,
      uptimeSeconds: process.uptime(),
    })
  );
});
