import { Router } from "express";
import { usersRouter } from "../modules/users/routes";
import { artistsRouter } from "../modules/artists/routes";
import { tracksRouter } from "../modules/tracks/routes";
import { albumsRouter } from "../modules/albums/routes";
import { libraryRouter } from "../modules/library/routes";
import { playlistsRouter } from "../modules/playlists/routes";
import { subscriptionsRouter } from "../modules/subscriptions/routes";
import { creatorRouter } from "../modules/creator/routes";
import { playsRouter } from "../modules/plays/routes";
import { privacyRouter } from "../modules/privacy/routes";
import { stripeRouter } from "../modules/stripe/routes";
import { billingRouter } from "../modules/billing/routes";
import { rateLimit } from "../lib/rateLimit";
import { accountRouter } from "../modules/privacy/account";
import { creatorGenreRouter } from "../modules/creator/genre";
import { genresRouter } from "../modules/genres/routes";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Limites par jeton de session (lib/rateLimit.ts), très au-dessus d'un usage normal : un battement
// toutes les 15 s, quelques appels par page. Elles protègent des boucles et des abus, pas des
// utilisateurs. Un dépassement répond 429 avec Retry-After.
const perMinute = (max: number) => rateLimit({ windowMs: 60_000, max });

apiRouter.use(perMinute(300)); // plancher global (hors /health, déclaré plus haut)
apiRouter.post("/plays", perMinute(60));
apiRouter.post("/plays/:id/heartbeat", perMinute(30));
apiRouter.use("/creator", perMinute(120));
apiRouter.get("/creator/artist/name-check", perMinute(30));
apiRouter.post(
  [
    "/creator/artist/upload-url",
    "/creator/albums/:id/cover-upload-url",
    "/creator/tracks/:id/upload-url",
    "/creator/tracks/:id/files", // lit le fichier audio en entier : le plus coûteux
  ],
  perMinute(30)
);
// Export et suppression de compte : lourds ou irréversibles, donc très peu par heure.
const perHour = (max: number) => rateLimit({ windowMs: 3_600_000, max });
apiRouter.get("/me/export", perHour(5));
apiRouter.post("/me/delete", perHour(5));
apiRouter.use("/billing", perMinute(10)); // chaque appel crée des objets chez Stripe
apiRouter.use("/stripe", perMinute(30));

apiRouter.use("/", usersRouter);
apiRouter.use("/", privacyRouter);
apiRouter.use("/", accountRouter);
apiRouter.use("/artists", artistsRouter);
apiRouter.use("/genres", genresRouter);
apiRouter.use("/tracks", tracksRouter);
apiRouter.use("/albums", albumsRouter);
apiRouter.use("/library", libraryRouter);
apiRouter.use("/playlists", playlistsRouter);
apiRouter.use("/subscriptions", subscriptionsRouter);
// Le genre d'un morceau : routes à part, montées avant le routeur principal.
apiRouter.use("/creator", creatorGenreRouter);
apiRouter.use("/creator", creatorRouter);
apiRouter.use("/plays", playsRouter);
apiRouter.use("/stripe", stripeRouter);
apiRouter.use("/billing", billingRouter);
