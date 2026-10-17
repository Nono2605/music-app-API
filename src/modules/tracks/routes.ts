import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { loadTrackProvenance } from "../../lib/loadProvenance";
import { hidesExplicit } from "../../lib/explicit";

export const tracksRouter = Router();

// GET /tracks — catalogue public, paginé, morceaux publiés uniquement.
// ?q= filtre par titre (recherche partielle, insensible à la casse) ;
// ?explicit=false écarte les morceaux explicites (réglage de l'auditeur).
tracksRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    let query = supabaseAdmin
      .from("tracks")
      .select("id, title, slug, duration_seconds, explicit, artists(name), albums(cover_url)")
      .eq("status", "published");

    if (q) query = query.ilike("title", `%${q}%`);
    if (hidesExplicit(req.query)) query = query.eq("explicit", false);

    const { data, error } = await query
      .order("published_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    // Provenance IA de chaque morceau : « ai », « hybrid » ou null (pas de badge).
    const provenance = await loadTrackProvenance(data.map((track) => track.id));
    res.json({ data: data.map((track) => ({ ...track, provenance: provenance.get(track.id) ?? null })), limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /tracks/:id — métadonnées publiques d'un morceau publié.
// Ne renvoie jamais de storage_key/URL brute ici : la lecture audio passe
// par POST /plays (modules/plays), qui compte l'écoute.
tracksRouter.get("/:id", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("tracks")
      .select("id, title, slug, duration_seconds, explicit, status, artist_id, album_id")
      .eq("id", req.params.id)
      .eq("status", "published")
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Track not found" });
    const provenance = await loadTrackProvenance([data.id]);
    res.json({ ...data, provenance: provenance.get(data.id) ?? null });
  } catch (err) {
    next(err);
  }
});
