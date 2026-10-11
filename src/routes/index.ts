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

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

apiRouter.use("/", usersRouter);
apiRouter.use("/", privacyRouter);
apiRouter.use("/artists", artistsRouter);
apiRouter.use("/tracks", tracksRouter);
apiRouter.use("/albums", albumsRouter);
apiRouter.use("/library", libraryRouter);
apiRouter.use("/playlists", playlistsRouter);
apiRouter.use("/subscriptions", subscriptionsRouter);
apiRouter.use("/creator", creatorRouter);
apiRouter.use("/plays", playsRouter);
