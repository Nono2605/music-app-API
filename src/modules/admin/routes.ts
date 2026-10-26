import { Router } from "express";
import { env } from "../../config/env";
import { buildConfigReport } from "../../lib/configReport";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { acrCloudRequestsThisMonth, countOpenScanJobs, enqueueOneTrackScan, scanRunner } from "../../lib/scanQueue";
import { requireAuthStrict } from "../../middleware/auth";
import { requireAdmin } from "../../middleware/requireAdmin";
import { isUuid } from "../albums/list";

export const adminRouter = Router();

// GET /admin/config — ce qui est réglé sur cette API (modes, secrets réglés oui / non, version déployée). RÉSERVÉ AUX
// ADMINS. Ne renvoie jamais la valeur d'un secret : voir lib/configReport.ts. Sert à la page « System » de l'admin.
adminRouter.get("/config", requireAuthStrict, requireAdmin, async (_req, res, next) => {
  try {
    const report = buildConfigReport(env, {
      commit: process.env.RENDER_GIT_COMMIT,
      nodeVersion: process.version,
      uptimeSeconds: process.uptime(),
    });
    // Les requêtes déjà envoyées à ACRCloud ce mois-ci (pour le plafond) : lues dans le journal, jamais bloquantes.
    if (report.fingerprint.active) {
      report.fingerprint.requests_this_month = await acrCloudRequestsThisMonth().catch(() => null);
    }
    res.json(report);
  } catch (err) {
    next(err);
  }
});

const QUEUE_MISSING = {
  error: "The automatic checks are not set up: apply 20261026000000_scan_jobs.sql (API repository) in the Supabase SQL editor.",
  code: "scan_queue_missing",
};

// POST /admin/scans/run — réveille l'exécuteur des contrôles automatiques (voir lib/scanRunner.ts). L'API tourne sur une
// offre qui s'endort : ce bouton reprend les contrôles restés en file. Rend le nombre de tâches qui attendent : 0 veut dire
// que rien n'était en file (un morceau jamais mis en file n'est PAS repris par ce bouton).
adminRouter.post("/scans/run", requireAuthStrict, requireAdmin, async (_req, res, next) => {
  try {
    const waiting = await countOpenScanJobs();
    if (waiting === null) return res.status(503).json(QUEUE_MISSING);
    void scanRunner.kick();
    res.json({ started: true, waiting });
  } catch (err) {
    next(err);
  }
});

// POST /admin/tracks/:id/scan — relance les contrôles automatiques d'UN morceau. `queued: false` avec `reason:
// "already_open"` : une tâche attend ou tourne déjà. File absente : 503 avec la migration à appliquer.
adminRouter.post("/tracks/:id/scan", requireAuthStrict, requireAdmin, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "Track not found" });
    const outcome = await enqueueOneTrackScan(req.params.id, "manual");
    if (outcome === "unavailable") return res.status(503).json(QUEUE_MISSING);
    if (outcome === "error") return res.status(502).json({ error: "The check could not be queued: see the API logs.", code: "scan_queue_error" });
    void scanRunner.kick();
    res.json(outcome === "queued" ? { queued: true } : { queued: false, reason: "already_open" });
  } catch (err) {
    next(err);
  }
});

// POST /admin/scans/queue-review — met en file les contrôles de TOUS les morceaux en attente de relecture (200 au plus). Pour
// ceux qui ont été envoyés avant la file, ou quand elle n'existait pas. Un fichier déjà contrôlé n'est pas renvoyé à
// ACRCloud (le résultat est repris), donc relancer ne coûte pas de requête de plus.
adminRouter.post("/scans/queue-review", requireAuthStrict, requireAdmin, async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.from("tracks").select("id").eq("status", "in_review").order("created_at", { ascending: true }).limit(200);
    if (error) throw error;
    const ids = (data ?? []).map((row) => row.id as string);
    let queued = 0;
    let alreadyOpen = 0;
    for (const id of ids) {
      const outcome = await enqueueOneTrackScan(id, "manual");
      if (outcome === "unavailable") return res.status(503).json(QUEUE_MISSING);
      if (outcome === "error") return res.status(502).json({ error: "The checks could not be queued: see the API logs.", code: "scan_queue_error" });
      if (outcome === "queued") queued++;
      else alreadyOpen++;
    }
    if (queued > 0) void scanRunner.kick();
    res.json({ in_review: ids.length, queued, already_open: alreadyOpen });
  } catch (err) {
    next(err);
  }
});
