import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { containsPattern, isUuid, parseListParams, toAlbumSummary, type AlbumRow } from "./list";
import { loadTrackProvenance } from "../../lib/loadProvenance";
import { loadTrackMeta } from "../../lib/loadTrackMeta";
import { loadTrackLikeCounts } from "../../lib/loadLikeCounts";
import { albumProvenance } from "../../lib/publicProvenance";
import { isMissingColumn } from "../../lib/schemaCompat";
import { cleanSearch, genreFilter, parseGenreParam } from "../../lib/searchTerms";
import { EMPTY_META, metaFields, topGenres } from "../../lib/trackMeta";
import { anyExplicit, hidesExplicit } from "../../lib/explicit";

export const albumsRouter = Router();

// GET /albums — catalogue public, paginé : albums publiés qui ont au moins un
// morceau publié (une release vide mènerait à une page sans rien à écouter), les
// plus récents d'abord. ?q= cherche dans le titre et le label (recherche partielle, insensible à la casse) ;
// ?genre=<code> ne garde que les albums dont un morceau publié est de ce genre ;
// ?artist_id= ne garde que les albums de cet artiste (page artiste) ;
// ?explicit=false écarte les albums (et singles) dont un morceau est explicite : la page peut alors
// contenir moins de `limit` albums.
albumsRouter.get("/", async (req, res, next) => {
  try {
    const { limit, offset, q } = parseListParams(req.query);

    // Un identifiant qui n'est pas un UUID ferait échouer la requête SQL (500) : on le
    // refuse proprement.
    const artistId = req.query.artist_id;
    if (artistId !== undefined && !isUuid(artistId)) {
      return res.status(400).json({ error: "artist_id must be a UUID" });
    }

    const genre = parseGenreParam(req.query.genre);
    const term = cleanSearch(q);

    // tracks!inner + filtre sur la relation : ne garde que les albums dont un morceau
    // publié existe, et ne renvoie que ces morceaux (on n'en garde que le nombre).
    // Avant la migration des détails de release, le label et les styles n'existent pas : on retombe sur la
    // recherche par titre d'avant, sans filtre de genre.
    const run = (extended: boolean) => {
      let query = supabaseAdmin
        .from("albums")
        .select("id, title, cover_url, release_date, type, artists(name, slug), tracks!inner(id, explicit)")
        .eq("status", "published")
        .eq("tracks.status", "published");

      if (q && extended && term) query = query.or(`title.ilike.%${term}%,label.ilike.%${term}%`);
      else if (q) query = query.ilike("title", containsPattern(q));
      if (extended && genre) query = query.or(genreFilter(genre), { referencedTable: "tracks" });
      if (artistId) query = query.eq("artist_id", artistId);

      return query
        .order("release_date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
    };

    let { data, error } = await run(true);
    if (error && isMissingColumn(error)) ({ data, error } = await run(false));

    if (error) throw error;
    const rows = data as unknown as AlbumRow[];
    const byTrack = await loadTrackProvenance(rows.flatMap((row) => (row.tracks ?? []).map((track) => track.id)));
    const visible = hidesExplicit(req.query) ? rows.filter((row) => !anyExplicit(row.tracks)) : rows;
    res.json({ data: visible.map((row) => toAlbumSummary(row, byTrack)), limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /albums/:id — métadonnées + tracklist (morceaux publiés, dans l'ordre). Avec le label, la mention de copyright,
// la description et les genres de l'album (ceux qui reviennent le plus parmi ses morceaux) ; chaque morceau porte ses
// genres, ses styles et ses crédits.
albumsRouter.get("/:id", async (req, res, next) => {
  try {
    type AlbumDetailRow = {
      id: string;
      label?: string | null;
      copyright_line?: string | null;
      description?: string | null;
    } & Record<string, unknown>;
    type AlbumResult = { data: AlbumDetailRow | null; error: { code?: string; message?: string } | null };

    // Avant la migration des détails de release, ces trois colonnes manquent : on les omet plutôt que de répondre 500.
    const read = (columns: string) =>
      supabaseAdmin
        .from("albums")
        .select(columns)
        .eq("id", req.params.id)
        .eq("status", "published")
        .maybeSingle() as unknown as PromiseLike<AlbumResult>;
    const base = "id, title, cover_url, release_date, type, artists(name, slug)";
    let { data: album, error } = await read(`${base}, label, copyright_line, description`);
    if (error && isMissingColumn(error)) ({ data: album, error } = await read(base));

    if (error) throw error;
    if (!album) return res.status(404).json({ error: "Album not found" });

    const { data: tracks, error: tracksError } = await supabaseAdmin
      .from("tracks")
      .select("id, title, slug, duration_seconds, track_number, explicit")
      .eq("album_id", album.id)
      .eq("status", "published")
      .order("track_number", { ascending: true });

    if (tracksError) throw tracksError;

    // Provenance IA et détails de chaque morceau, et provenance de l'album (100 % IA seulement si tous le sont).
    const ids = tracks.map((track) => track.id);
    const [byTrack, meta, likes] = await Promise.all([
      loadTrackProvenance(ids),
      loadTrackMeta(ids),
      loadTrackLikeCounts(ids),
    ]);
    const withDetails = tracks.map((track) => ({
      ...track,
      provenance: byTrack.get(track.id) ?? null,
      likes_count: likes.get(track.id) ?? 0,
      ...metaFields(meta.get(track.id)),
    }));
    res.json({
      ...album,
      label: album.label ?? null,
      copyright_line: album.copyright_line ?? null,
      description: album.description ?? null,
      genres: topGenres(ids.map((id) => meta.get(id) ?? EMPTY_META)),
      explicit: anyExplicit(tracks),
      provenance: albumProvenance(withDetails.map((track) => track.provenance)),
      tracks: withDetails,
    });
  } catch (err) {
    next(err);
  }
});
