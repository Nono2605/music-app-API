import { app } from "./app";
import { env } from "./config/env";
import { scanRunner } from "./lib/scanQueue";

app.listen(env.port, () => {
  console.log(`musicAPI listening on port ${env.port} (${env.nodeEnv})`);
  // Les contrôles restés en file pendant que l'API dormait (ou plantait) reprennent au démarrage.
  setTimeout(() => void scanRunner.kick(), 10_000).unref();
});
