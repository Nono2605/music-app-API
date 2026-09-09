import { app } from "./app";
import { env } from "./config/env";

app.listen(env.port, () => {
  console.log(`musicAPI listening on port ${env.port} (${env.nodeEnv})`);
});
