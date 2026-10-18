import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";
import { isMissingColumn } from "../../lib/schemaCompat";
import { loadTrackProvenance } from "../../lib/loadProvenance";
import { loadTrackMeta } from "../../lib/loadTrackMeta";
import { loadTrackLikeCounts } from "../../lib/loadLikeCounts";
import { genreFilter, parseGenreParam } from "../../lib/searchTerms";
import { EMPTY_META, metaFields, topGenres } from "../../lib/trackMeta";
import { hidesExplicit } from "../../lib/explicit";

export const artistsRouter = Router();

// GET /artists — catalogue public, paginé.
// ?q= filtre par nom (recherche partielle, insensible à la casse) ;
// ?genre=<code> ne garde que les artistes dont un morceau publié est de ce genre.
artistsRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const genre = parseGenreParam(req.query.genre);

    // Un artiste anonymisé (compte supprimé) n'apparaît plus, ni un artiste dont le nom attend la décision de
    // l'administration ou a été refusé (`name_status`). Tant que les migrations qui ajoutent ces colonnes ne
    // sont pas appliquées, on retombe sur la requête d'avant plutôt que de répondre 500.
    // Avec un genre : les artistes qui ont au moins un morceau publié de ce genre (jointure interne sur leurs morceaux ;
    // on n'en garde pas la liste dans la réponse).
    const columns = genre
      ? "id, name, slug, avatar_url, verified, tracks!inner(id)"
      : "id, name, slug, avatar_url, verified";
    const run = (hideAnonymized: boolean, hideUnapproved: boolean) => {
      let query = supabaseAdmin.from("artists").select(columns);
      if (hideAnonymized) query = query.is("anonymized_at", null);
      if (hideUnapproved) query = query.eq("name_status", "approved");
      if (genre) {
        query = query.eq("tracks.status", "published").or(genreFilter(genre), { referencedTable: "tracks" });
      }
      if (q) query = query.ilike("name", `%${q}%`);
      return query.order("name", { ascending: true }).range(offset, offset + limit - 1);
    };

    let { data, error } = await run(true, true);
    if (error && isMissingColumn(error)) ({ data, error } = await run(true, false));
    if (error && isMissingColumn(error)) ({ data, error } = await run(false, false));

    if (error) throw error;
    // Le genre renvoie aussi la liste des morceaux joints : seule l'identité de l'artiste intéresse l'app.
    const artists = ((data ?? []) as unknown as Record<string, unknown>[]).map(({ tracks: _tracks, ...artist }) => artist);
    res.json({ data: artists, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /artists/:slug — profil + discographie (morceaux publiés) + nombre de followers (le nombre seulement,
// jamais qui). ?explicit=false écarte les morceaux explicites.
artistsRouter.get("/:slug", async (req, res, next) => {
  try {
    const run = (hideAnonymized: boolean, hideUnapproved: boolean) => {
      let query = supabaseAdmin
        .from("artists")
        .select("id, name, slug, bio, avatar_url, banner_url, verified")
        .eq("slug", req.params.slug);
      if (hideAnonymized) query = query.is("anonymized_at", null);
      if (hideUnapproved) query = query.eq("name_status", "approved");
      return query.maybeSingle();
    };

    let { data: artist, error } = await run(true, true);
    if (error && isMissingColumn(error)) ({ data: artist, error } = await run(true, false));
    if (error && isMissingColumn(error)) ({ data: artist, error } = await run(false, false));

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
    const ids = tracks.map((track) => track.id);
    const [provenance, meta, likes] = await Promise.all([
      loadTrackProvenance(ids),
      loadTrackMeta(ids),
      loadTrackLikeCounts(ids),
    ]);
    res.json({
      ...artist,
      followers_count: followers.error ? null : (followers.count ?? 0),
      // Les genres de l'artiste : ceux qui reviennent le plus parmi ses morceaux publiés.
      genres: topGenres(ids.map((id) => meta.get(id) ?? EMPTY_META)),
      tracks: tracks.map((track) => ({
        ...track,
        provenance: provenance.get(track.id) ?? null,
        likes_count: likes.get(track.id) ?? 0,
        ...metaFields(meta.get(track.id)),
      })),
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
