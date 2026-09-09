import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env";
import { apiRouter } from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: env.corsAllowedOrigins.length > 0 ? env.corsAllowedOrigins : false,
  })
);
app.use(express.json());

app.use("/", apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);
