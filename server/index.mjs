import { configFromEnv } from "./config.mjs";
import { createApp } from "./app.mjs";
const config = configFromEnv();
const service = await createApp(config);
const server = service.app.listen(config.port, config.host, () =>
  console.log(
    "Overheidsportaal: " +
      config.origin +
      (config.discordReady ? "" : " (Discord-configuratie ontbreekt)"),
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      service.close();
      process.exit(0);
    }),
  );
