import { Router } from "express";
import { env } from "../../config/env";
import {
  VERSION_PATTERN,
  parseConsentInput,
  privacyState,
  rowsToInsert,
  type ConsentRecord,
} from "../../lib/consents";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";

export const privacyRouter = Router();

// Table absente (migration pas encore appliquée) : ce n'est pas une panne, le client
// affiche « pas encore disponible » au lieu d'une erreur. Même convention que /creator/stats.
const NOT_MIGRATED_CODES = new Set(["42P01", "PGRST205"]);

async function loadConsents(userId: string): Promise<ConsentRecord[]> {
  const { data, error } = await supabaseAdmin
    .from("consents")
    .select("purpose, granted, policy_version, created_at")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []) as ConsentRecord[];
}

function unavailable(res: import("express").Response) {
  return res.status(503).json({ error: "Privacy settings are not available yet", code: "privacy_unavailable" });
}

// GET /me/privacy?version=<étiquette du texte> — où en est ce compte : faut-il montrer
// l'écran d'accueil (conditions + âge) ? quels choix facultatifs a-t-il faits ? La version
// est celle du texte que l'app AFFICHE : c'est elle qui décide si l'acceptation est à jour.
privacyRouter.get("/me/privacy", requireAuth, async (req, res, next) => {
  try {
    const version = typeof req.query.version === "string" ? req.query.version : "";
    if (!VERSION_PATTERN.test(version)) {
      return res.status(400).json({ error: "version is required (letters, digits, . _ -; 40 characters max)" });
    }

    res.json(privacyState(await loadConsents(req.auth!.id), version, env.privacy));
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code && NOT_MIGRATED_CODES.has(code)) return unavailable(res);
    next(err);
  }
});

// POST /me/consents — enregistre une acceptation ou un choix :
//   { policy_version, accept_terms?: true, age_attested?: true, choices?: { <finalité>: bool }, source? }
// Chaque décision ajoute une ligne à l'historique ; rien n'est jamais modifié. Rejouer la
// même demande n'ajoute rien. Renvoie le même état que GET /me/privacy.
privacyRouter.post("/me/consents", requireAuth, async (req, res, next) => {
  try {
    const parsed = parseConsentInput(req.body, env.privacy);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const existing = await loadConsents(req.auth!.id);
    const plan = rowsToInsert(existing, parsed.input, env.privacy);
    if (!plan.ok) return res.status(400).json({ error: plan.error });

    if (plan.rows.length > 0) {
      const { error } = await supabaseAdmin
        .from("consents")
        .insert(plan.rows.map((row) => ({ ...row, user_id: req.auth!.id })));
      if (error) throw error;
    }

    res.json(privacyState(await loadConsents(req.auth!.id), parsed.input.version, env.privacy));
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code && NOT_MIGRATED_CODES.has(code)) return unavailable(res);
    next(err);
  }
});
