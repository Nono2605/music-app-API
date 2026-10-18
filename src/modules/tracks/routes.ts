import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { loadTrackProvenance } from "../../lib/loadProvenance";
import { loadTrackLikeCounts } from "../../lib/loadLikeCounts";
import { creditedTrackIds, loadGenreLabels, loadTrackMeta } from "../../lib/loadTrackMeta";
import { isMissingColumn } from "../../lib/schemaCompat";
import {
  buildTrackSearchFilter,
  cleanSearch,
  genreCodesMatching,
  genreFilter,
  parseGenreParam,
  parseTagParam,
} from "../../lib/searchTerms";
import { metaFields } from "../../lib/trackMeta";
import { hidesExplicit } from "../../lib/explicit";
import { firstRelation } from "../../lib/relation";
import { requireAuth } from "../../middleware/auth";
import { isUuid } from "../albums/list";

export const tracksRouter = Router();

// GET /tracks — catalogue public, paginé, morceaux publiés uniquement.
// ?q= cherche dans le titre, les styles (mot exact), les genres (dont le libellé contient le terme) et les artistes
// crédités sur le morceau ; ?genre=<code> garde les morceaux de ce genre (principal ou non) ; ?tag=<style> ceux qui
// portent ce style ; ?explicit=false écarte les morceaux explicites (réglage de l'auditeur).
// Chaque morceau porte ses genres (le principal d'abord), ses styles et ses crédits.
tracksRouter.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);
    const q = cleanSearch(req.query.q);
    const genre = parseGenreParam(req.query.genre);
    const tag = parseTagParam(req.query.tag);

    // Avant la migration des détails de release, les colonnes des styles manquent : on retombe sur la recherche par
    // titre d'avant, sans filtre de genre ni de style, plutôt que de répondre 500.
    const run = async (extended: boolean) => {
      let query = supabaseAdmin
        .from("tracks")
        .select("id, title, slug, duration_seconds, explicit, artists(name), albums(cover_url)")
        .eq("status", "published");

      if (q && extended) {
        const labels = await loadGenreLabels();
        const genreCodes = genreCodesMatching(
          q,
          [...labels].map(([code, label]) => ({ code, label }))
        );
        query = query.or(buildTrackSearchFilter({ term: q, genreCodes, creditedTrackIds: await creditedTrackIds(q) }));
      } else if (q) {
        query = query.ilike("title", `%${q}%`);
      }
      if (extended && genre) query = query.or(genreFilter(genre));
      if (extended && tag) query = query.contains("tags", [tag]);
      if (hidesExplicit(req.query)) query = query.eq("explicit", false);

      return query.order("published_at", { ascending: false }).range(offset, offset + limit - 1);
    };

    let { data, error } = await run(true);
    if (error && isMissingColumn(error)) ({ data, error } = await run(false));
    if (error) throw error;
    if (!data) throw new Error("No data");

    // Provenance IA de chaque morceau (« ai », « hybrid » ou null : pas de badge), ses détails et son nombre de « j'aime ».
    const ids = data.map((track) => track.id);
    const [provenance, meta, likes] = await Promise.all([
      loadTrackProvenance(ids),
      loadTrackMeta(ids),
      loadTrackLikeCounts(ids),
    ]);
    res.json({
      data: data.map((track) => ({
        ...track,
        provenance: provenance.get(track.id) ?? null,
        likes_count: likes.get(track.id) ?? 0,
        ...metaFields(meta.get(track.id)),
      })),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

// GET /tracks/:id/context — ce que la platine (le lecteur plein écran) doit savoir du morceau en cours pour
// proposer « j'aime » et « suivre l'artiste » : l'artiste, l'album, et si l'auditeur a déjà sauvegardé ce
// morceau et suit déjà cet artiste. Une requête au lieu de trois.
tracksRouter.get("/:id/context", requireAuth, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "Track not found" });

    const { data: track, error } = await supabaseAdmin
      .from("tracks")
      .select("id, artists(id, name, slug), albums(id, title)")
      .eq("id", req.params.id)
      .eq("status", "published")
      .maybeSingle();
    if (error) throw error;
    if (!track) return res.status(404).json({ error: "Track not found" });

    const artist = firstRelation(track.artists as { id: string; name: string; slug: string } | { id: string; name: string; slug: string }[] | null);
    const album = firstRelation(track.albums as { id: string; title: string } | { id: string; title: string }[] | null);
    const userId = req.auth!.id;

    const [likes, saved, following] = await Promise.all([
      loadTrackLikeCounts([track.id]),
      supabaseAdmin
        .from("library")
        .select("id")
        .eq("user_id", userId)
        .eq("item_type", "track")
        .eq("item_id", track.id)
        .maybeSingle(),
      artist
        ? supabaseAdmin.from("follows").select("id").eq("follower_id", userId).eq("artist_id", artist.id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (saved.error) throw saved.error;
    if (following.error) throw following.error;

    res.json({ artist, album, saved: !!saved.data, following: !!following.data, likes_count: likes.get(track.id) ?? 0 });
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
    const [provenance, meta, likes] = await Promise.all([
      loadTrackProvenance([data.id]),
      loadTrackMeta([data.id]),
      loadTrackLikeCounts([data.id]),
    ]);
    res.json({
      ...data,
      provenance: provenance.get(data.id) ?? null,
      likes_count: likes.get(data.id) ?? 0,
      ...metaFields(meta.get(data.id)),
    });
  } catch (err) {
    next(err);
  }
});
