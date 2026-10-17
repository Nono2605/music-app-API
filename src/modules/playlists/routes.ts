import { Router } from "express";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";
import { addTrackOutcome } from "./addTrack";
import { loadTrackProvenance } from "../../lib/loadProvenance";
import { isUuid } from "../albums/list";

export const playlistsRouter = Router();

// GET /playlists — les playlists de l'utilisateur connecté.
playlistsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("playlists")
      .select("id, title, description, cover_url, is_public, created_at")
      .eq("owner_id", req.auth!.id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// POST /playlists
playlistsRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const { title, description, is_public: isPublic } = req.body ?? {};
    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return res.status(400).json({ error: "title is required" });
    }

    const { data, error } = await supabaseAdmin
      .from("playlists")
      .insert({
        owner_id: req.auth!.id,
        title: title.trim(),
        description: description ?? null,
        is_public: !!isPublic,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// GET /playlists/:id — playlist + morceaux, dans l'ordre.
// Visible si publique, ou si l'utilisateur connecté en est propriétaire.
playlistsRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const { data: playlist, error } = await supabaseAdmin
      .from("playlists")
      .select("id, owner_id, title, description, cover_url, is_public, created_at")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });

    const isOwner = playlist.owner_id === req.auth!.id;
    if (!playlist.is_public && !isOwner) {
      return res.status(404).json({ error: "Playlist not found" });
    }

    // Seulement les morceaux publiés : un morceau retiré du catalogue (refusé, archivé) disparaît de la
    // playlist au lieu d'y rester, illisible. La ligne reste en base : elle revient s'il est republié.
    const { data: playlistTracks, error: tracksError } = await supabaseAdmin
      .from("playlist_tracks")
      .select("position, tracks!inner(id, title, slug, duration_seconds, explicit, artists(name), albums(cover_url))")
      .eq("playlist_id", playlist.id)
      .eq("tracks.status", "published")
      .order("position", { ascending: true });

    if (tracksError) throw tracksError;

    const tracks = playlistTracks.map((pt) => ({ ...(pt.tracks as unknown as { id: string }), position: pt.position }));
    const provenance = await loadTrackProvenance(tracks.map((track) => track.id));

    res.json({
      ...playlist,
      is_owner: isOwner,
      tracks: tracks.map((track) => ({ ...track, provenance: provenance.get(track.id) ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

async function requireOwnedPlaylist(playlistId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("playlists")
    .select("id, owner_id")
    .eq("id", playlistId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.owner_id !== userId) return null;
  return data;
}

// PATCH /playlists/:id — propriétaire uniquement.
playlistsRouter.patch("/:id", requireAuth, async (req, res, next) => {
  try {
    const owned = await requireOwnedPlaylist(req.params.id, req.auth!.id);
    if (!owned) return res.status(404).json({ error: "Playlist not found" });

    const { title, description, is_public: isPublic } = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = String(title).trim();
    if (description !== undefined) patch.description = description;
    if (isPublic !== undefined) patch.is_public = !!isPublic;

    const { data, error } = await supabaseAdmin
      .from("playlists")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE /playlists/:id — propriétaire uniquement.
playlistsRouter.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const owned = await requireOwnedPlaylist(req.params.id, req.auth!.id);
    if (!owned) return res.status(404).json({ error: "Playlist not found" });

    const { error } = await supabaseAdmin.from("playlists").delete().eq("id", req.params.id);
    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /playlists/:id/tracks — ajoute en fin de playlist. Répond { added } : false si le morceau y était déjà.
playlistsRouter.post("/:id/tracks", requireAuth, async (req, res, next) => {
  try {
    const owned = await requireOwnedPlaylist(req.params.id, req.auth!.id);
    if (!owned) return res.status(404).json({ error: "Playlist not found" });

    const { track_id: trackId } = req.body ?? {};
    if (!trackId) return res.status(400).json({ error: "track_id is required" });
    if (!isUuid(trackId)) return res.status(400).json({ error: "track_id must be a UUID" });

    // Seul un morceau publié peut entrer dans une playlist (pas un brouillon ni un morceau refusé).
    const { data: track, error: trackError } = await supabaseAdmin
      .from("tracks")
      .select("id")
      .eq("id", trackId)
      .eq("status", "published")
      .maybeSingle();
    if (trackError) throw trackError;
    if (!track) return res.status(404).json({ error: "Track not found" });

    const { data: last, error: lastError } = await supabaseAdmin
      .from("playlist_tracks")
      .select("position")
      .eq("playlist_id", req.params.id)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw lastError;

    const nextPosition = (last?.position ?? -1) + 1;

    const { error } = await supabaseAdmin.from("playlist_tracks").insert({
      playlist_id: req.params.id,
      track_id: trackId,
      position: nextPosition,
      added_by: req.auth!.id,
    });

    // 201 : ajouté ; 200 : le morceau était déjà dans la playlist (rien n'est dupliqué).
    const outcome = addTrackOutcome(error);
    if (outcome === "duplicate") return res.status(200).json({ added: false });
    res.status(201).json({ added: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /playlists/:id/tracks/:trackId — retire un morceau et renumérote
// les positions restantes pour ne pas laisser de trous.
playlistsRouter.delete("/:id/tracks/:trackId", requireAuth, async (req, res, next) => {
  try {
    const owned = await requireOwnedPlaylist(req.params.id, req.auth!.id);
    if (!owned) return res.status(404).json({ error: "Playlist not found" });

    const { error: deleteError } = await supabaseAdmin
      .from("playlist_tracks")
      .delete()
      .eq("playlist_id", req.params.id)
      .eq("track_id", req.params.trackId);
    if (deleteError) throw deleteError;

    const { data: remaining, error: remainingError } = await supabaseAdmin
      .from("playlist_tracks")
      .select("track_id, position")
      .eq("playlist_id", req.params.id)
      .order("position", { ascending: true });
    if (remainingError) throw remainingError;

    await Promise.all(
      remaining.map((row, index) =>
        row.position === index
          ? Promise.resolve()
          : supabaseAdmin
              .from("playlist_tracks")
              .update({ position: index })
              .eq("playlist_id", req.params.id)
              .eq("track_id", row.track_id)
      )
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
