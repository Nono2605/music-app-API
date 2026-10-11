import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env";
import { apiRouter } from "./routes";
import { stripeWebhook } from "./modules/stripe/webhook";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: env.corsAllowedOrigins.length > 0 ? env.corsAllowedOrigins : false,
  })
);
// Le webhook Stripe vérifie une signature calculée sur le corps BRUT : il doit passer avant le
// lecteur JSON, qui le consommerait.
app.post("/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), stripeWebhook);
app.use(express.json());

app.use("/", apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);
