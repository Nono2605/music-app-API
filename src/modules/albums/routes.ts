import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";

export const albumsRouter = Router();

// GET /albums/:id — métadonnées + tracklist (morceaux publiés, dans l'ordre).
albumsRouter.get("/:id", async (req, res, next) => {
  try {
    const { data: album, error } = await supabaseAdmin
      .from("albums")
      .select("id, title, cover_url, release_date, type, artists(name, slug)")
      .eq("id", req.params.id)
      .eq("status", "published")
      .maybeSingle();

    if (error) throw error;
    if (!album) return res.status(404).json({ error: "Album not found" });

    const { data: tracks, error: tracksError } = await supabaseAdmin
      .from("tracks")
      .select("id, title, slug, duration_seconds, track_number")
      .eq("album_id", album.id)
      .eq("status", "published")
      .order("track_number", { ascending: true });

    if (tracksError) throw tracksError;
    res.json({ ...album, tracks });
  } catch (err) {
    next(err);
  }
});
