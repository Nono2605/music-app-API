import { Router } from "express";
import { env } from "../../config/env";
import { buildConfigReport } from "../../lib/configReport";
import { enqueueTrackScans, scanRunner } from "../../lib/scanQueue";
import { requireAuthStrict } from "../../middleware/auth";
import { requireAdmin } from "../../middleware/requireAdmin";
import { isUuid } from "../albums/list";

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

// POST /admin/scans/run — réveille l'exécuteur des contrôles automatiques (voir lib/scanRunner.ts). L'API tourne sur une
// offre qui s'endort : ce bouton reprend les contrôles restés en file.
adminRouter.post("/scans/run", requireAuthStrict, requireAdmin, (_req, res) => {
  void scanRunner.kick();
  res.json({ started: true });
});

// POST /admin/tracks/:id/scan — relance les contrôles automatiques d'UN morceau. Sans effet s'ils sont déjà en cours.
adminRouter.post("/tracks/:id/scan", requireAuthStrict, requireAdmin, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "Track not found" });
    const queued = await enqueueTrackScans([req.params.id], "manual");
    void scanRunner.kick();
    res.json({ queued: queued > 0 });
  } catch (err) {
    next(err);
  }
});
