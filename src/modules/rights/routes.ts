import { Router } from "express";
import { clock } from "../../lib/clock";
import { submitClaim, type ClaimDb } from "../../lib/rightsClaim";
import { supabaseAdmin } from "../../lib/supabaseAdmin";

export const rightsRouter = Router();

const db: ClaimDb = {
  async countSince(sinceIso) {
    const { count, error } = await supabaseAdmin.from("rights_claims").select("id", { count: "exact", head: true }).gte("created_at", sinceIso);
    if (error) throw error;
    return count ?? 0;
  },
  async insert(row) {
    const { data, error } = await supabaseAdmin.from("rights_claims").insert(row).select("claim_number").single();
    if (error) throw error;
    return { claim_number: Number(data.claim_number) };
  },
};

// POST /rights/claims — le formulaire public de signalement des ayants droit (spec 15.3, C4). PAS de compte :
// la limite de fréquence se fait par adresse IP (routes/index.ts), et lib/rightsClaim.ts borne tout.
//   body : { name, email, organization?, capacity, claim_type, track_reference, original_work, description,
//            good_faith: true, website: "" (champ piège : doit rester vide) }
//   201 : { reference: "RC-00012" }
rightsRouter.post("/claims", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const result = await submitClaim(db, req.body, clock.now());
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});
