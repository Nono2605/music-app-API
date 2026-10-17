import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { containsPattern, isUuid, parseListParams, toAlbumSummary, type AlbumRow } from "./list";
import { loadTrackProvenance } from "../../lib/loadProvenance";
import { albumProvenance } from "../../lib/publicProvenance";
import { anyExplicit, hidesExplicit } from "../../lib/explicit";

export const albumsRouter = Router();

// GET /albums — catalogue public, paginé : albums publiés qui ont au moins un
// morceau publié (une release vide mènerait à une page sans rien à écouter), les
// plus récents d'abord. ?q= filtre par titre (recherche partielle, insensible à la casse) ;
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

    // tracks!inner + filtre sur la relation : ne garde que les albums dont un morceau
    // publié existe, et ne renvoie que ces morceaux (on n'en garde que le nombre).
    let query = supabaseAdmin
      .from("albums")
      .select("id, title, cover_url, release_date, type, artists(name, slug), tracks!inner(id, explicit)")
      .eq("status", "published")
      .eq("tracks.status", "published");

    if (q) query = query.ilike("title", containsPattern(q));
    if (artistId) query = query.eq("artist_id", artistId);

    const { data, error } = await query
      .order("release_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    const rows = data as unknown as AlbumRow[];
    const byTrack = await loadTrackProvenance(rows.flatMap((row) => (row.tracks ?? []).map((track) => track.id)));
    const visible = hidesExplicit(req.query) ? rows.filter((row) => !anyExplicit(row.tracks)) : rows;
    res.json({ data: visible.map((row) => toAlbumSummary(row, byTrack)), limit, offset });
  } catch (err) {
    next(err);
  }
});

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
      .select("id, title, slug, duration_seconds, track_number, explicit")
      .eq("album_id", album.id)
      .eq("status", "published")
      .order("track_number", { ascending: true });

    if (tracksError) throw tracksError;

    // Provenance IA de chaque morceau, et de l'album (100 % IA seulement si tous le sont).
    const byTrack = await loadTrackProvenance(tracks.map((track) => track.id));
    const withProvenance = tracks.map((track) => ({ ...track, provenance: byTrack.get(track.id) ?? null }));
    res.json({
      ...album,
      explicit: anyExplicit(tracks),
      provenance: albumProvenance(withProvenance.map((track) => track.provenance)),
      tracks: withProvenance,
    });
  } catch (err) {
    next(err);
  }
});
