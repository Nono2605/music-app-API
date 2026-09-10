import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";

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

// GET /artists/:slug — profil + discographie (morceaux publiés).
artistsRouter.get("/:slug", async (req, res, next) => {
  try {
    const { data: artist, error } = await supabaseAdmin
      .from("artists")
      .select("id, name, slug, bio, avatar_url, banner_url, verified")
      .eq("slug", req.params.slug)
      .maybeSingle();

    if (error) throw error;
    if (!artist) return res.status(404).json({ error: "Artist not found" });

    const { data: tracks, error: tracksError } = await supabaseAdmin
      .from("tracks")
      .select("id, title, slug, duration_seconds, albums(cover_url)")
      .eq("artist_id", artist.id)
      .eq("status", "published")
      .order("published_at", { ascending: false });

    if (tracksError) throw tracksError;
    res.json({ ...artist, tracks });
  } catch (err) {
    next(err);
  }
});

// POST /artists/:id/follow
artistsRouter.post("/:id/follow", requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from("follows")
      .insert({ follower_id: req.auth!.id, artist_id: req.params.id });

    if (error && error.code !== "23505") throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// DELETE /artists/:id/follow
artistsRouter.delete("/:id/follow", requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from("follows")
      .delete()
      .eq("follower_id", req.auth!.id)
      .eq("artist_id", req.params.id);

    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
