import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";

export const tracksRouter = Router();

// GET /tracks — catalogue public, paginé, morceaux publiés uniquement.
// ?q= filtre par titre (recherche partielle, insensible à la casse).
tracksRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    let query = supabaseAdmin
      .from("tracks")
      .select("id, title, slug, duration_seconds, artists(name), albums(cover_url)")
      .eq("status", "published");

    if (q) query = query.ilike("title", `%${q}%`);

    const { data, error } = await query
      .order("published_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ data, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /tracks/:id — métadonnées publiques d'un morceau publié.
// Ne renvoie jamais de storage_key/URL brute ici : la lecture audio passe
// par un flux d'autorisation dédié (voir DATA_FLOW.md, §3 Lecture/streaming).
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
    res.json(data);
  } catch (err) {
    next(err);
  }
});
