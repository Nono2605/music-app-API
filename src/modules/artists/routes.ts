import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";

export const artistsRouter = Router();

// GET /artists — catalogue public, paginé.
// ?q= filtre par nom (recherche partielle, insensible à la casse).
artistsRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    let query = supabaseAdmin.from("artists").select("id, name, slug, avatar_url, verified");
    if (q) query = query.ilike("name", `%${q}%`);

    const { data, error } = await query
      .order("name", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ data, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /artists/:slug
artistsRouter.get("/:slug", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("artists")
      .select("id, name, slug, bio, avatar_url, banner_url, verified")
      .eq("slug", req.params.slug)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Artist not found" });
    res.json(data);
  } catch (err) {
    next(err);
  }
});
