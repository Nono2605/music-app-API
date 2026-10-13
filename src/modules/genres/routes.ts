import { Router } from "express";
import { GenresUnavailableError, listGenres } from "../../lib/genres";

export const genresRouter = Router();

// GET /genres — la liste fermée des genres actifs (code et libellé), dans l'ordre d'affichage.
// Publique : ce sont les mêmes pour tout le monde, et rien de personnel.
genresRouter.get("/", async (_req, res, next) => {
  try {
    const genres = await listGenres();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ genres });
  } catch (err) {
    if (err instanceof GenresUnavailableError) {
      return res.status(503).json({ error: "Genres are not available yet", code: "genres_unavailable" });
    }
    next(err);
  }
});
