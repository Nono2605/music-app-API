import { Router } from "express";
import { usersRouter } from "../modules/users/routes";
import { artistsRouter } from "../modules/artists/routes";
import { tracksRouter } from "../modules/tracks/routes";
import { albumsRouter } from "../modules/albums/routes";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

apiRouter.use("/", usersRouter);
apiRouter.use("/artists", artistsRouter);
apiRouter.use("/tracks", tracksRouter);
apiRouter.use("/albums", albumsRouter);
