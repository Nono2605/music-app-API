import { Router } from "express";
import {
  GenresUnavailableError,
  isActiveGenre,
  parseGenreInput,
  readTrackGenre,
  writeTrackGenre,
} from "../../lib/genres";
import { myArtistId } from "../../lib/myArtistId";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import { requireAuth } from "../../middleware/auth";
import { requireCreator } from "../../middleware/requireCreator";

// Le genre d'un morceau du créateur connecté. Un routeur à part (monté sur /creator, avant le routeur
// principal) : les deux routes portent leurs propres contrôles d'accès, pour ne pas vérifier deux fois
// le jeton des routes qui ne sont pas les leurs.
export const creatorGenreRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function ownsTrack(userId: string, trackId: string): Promise<boolean> {
  const artistId = await myArtistId(userId);
  if (!artistId) return false;
  const { data, error } = await supabaseAdmin
    .from("tracks")
    .select("id")
    .eq("id", trackId)
    .eq("artist_id", artistId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

const unavailable = { error: "Genres are not available yet", code: "genres_unavailable" };

// GET /creator/tracks/:id/genre → { genre: "pop" | null }
creatorGenreRouter.get("/tracks/:id/genre", requireAuth, requireCreator, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id) || !(await ownsTrack(req.auth!.id, req.params.id))) {
      return res.status(404).json({ error: "Track not found" });
    }
    const genre = await readTrackGenre(req.params.id);
    if (genre === undefined) return res.status(503).json(unavailable);
    res.json({ genre });
  } catch (err) {
    next(err);
  }
});

// PUT /creator/tracks/:id/genre  { genre: "pop" } ou { genre: null } pour le retirer.
creatorGenreRouter.put("/tracks/:id/genre", requireAuth, requireCreator, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id) || !(await ownsTrack(req.auth!.id, req.params.id))) {
      return res.status(404).json({ error: "Track not found" });
    }
    const input = parseGenreInput(req.body?.genre);
    if (!input.ok) return res.status(400).json({ error: input.error });
    if (input.value !== null && !(await isActiveGenre(input.value))) {
      return res.status(400).json({ error: "Unknown genre", code: "unknown_genre" });
    }
    await writeTrackGenre(req.params.id, input.value);
    res.json({ genre: input.value });
  } catch (err) {
    if (err instanceof GenresUnavailableError) return res.status(503).json(unavailable);
    next(err);
  }
});
