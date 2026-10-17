import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";
import { isMissingColumn } from "../../lib/schemaCompat";
import { loadTrackProvenance } from "../../lib/loadProvenance";
import { hidesExplicit } from "../../lib/explicit";

export const artistsRouter = Router();

// GET /artists — catalogue public, paginé.
// ?q= filtre par nom (recherche partielle, insensible à la casse).
artistsRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    // Un artiste anonymisé (compte supprimé) n'apparaît plus. Tant que la migration
    // qui ajoute `anonymized_at` n'est pas appliquée, on retombe sur la requête
    // d'avant plutôt que de répondre 500.
    const run = (hideAnonymized: boolean) => {
      let query = supabaseAdmin.from("artists").select("id, name, slug, avatar_url, verified");
      if (hideAnonymized) query = query.is("anonymized_at", null);
      if (q) query = query.ilike("name", `%${q}%`);
      return query.order("name", { ascending: true }).range(offset, offset + limit - 1);
    };

    let { data, error } = await run(true);
    if (error && isMissingColumn(error)) ({ data, error } = await run(false));

    if (error) throw error;
    res.json({ data, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /artists/:slug — profil + discographie (morceaux publiés) + nombre de followers (le nombre seulement,
// jamais qui). ?explicit=false écarte les morceaux explicites.
artistsRouter.get("/:slug", async (req, res, next) => {
  try {
    const run = (hideAnonymized: boolean) => {
      let query = supabaseAdmin
        .from("artists")
        .select("id, name, slug, bio, avatar_url, banner_url, verified")
        .eq("slug", req.params.slug);
      if (hideAnonymized) query = query.is("anonymized_at", null);
      return query.maybeSingle();
    };

    let { data: artist, error } = await run(true);
    if (error && isMissingColumn(error)) ({ data: artist, error } = await run(false));

    if (error) throw error;
    if (!artist) return res.status(404).json({ error: "Artist not found" });

    let tracksQuery = supabaseAdmin
      .from("tracks")
      .select("id, title, slug, duration_seconds, explicit, albums(cover_url)")
      .eq("artist_id", artist.id)
      .eq("status", "published");
    if (hidesExplicit(req.query)) tracksQuery = tracksQuery.eq("explicit", false);
    // Le nombre de followers est public, la liste de qui suit ne l'est pas : on ne renvoie que le nombre.
    const [{ data: tracks, error: tracksError }, followers] = await Promise.all([
      tracksQuery.order("published_at", { ascending: false }),
      supabaseAdmin.from("follows").select("id", { count: "exact", head: true }).eq("artist_id", artist.id),
    ]);

    if (tracksError) throw tracksError;
    // Une statistique secondaire : si elle échoue, la page s'affiche sans (null) au lieu de tomber.
    if (followers.error) console.error("artist followers count failed", followers.error);
    const provenance = await loadTrackProvenance(tracks.map((track) => track.id));
    res.json({
      ...artist,
      followers_count: followers.error ? null : (followers.count ?? 0),
      tracks: tracks.map((track) => ({ ...track, provenance: provenance.get(track.id) ?? null })),
    });
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
