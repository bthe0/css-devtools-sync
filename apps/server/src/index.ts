import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

try {
  const cfg = loadConfig();
  const app = await startServer(cfg);
  app.log.info(
    { port: cfg.port, appEnv: cfg.appEnv, llmPlacement: cfg.appEnv !== "production" && Boolean(cfg.anthropicApiKey) },
    "css-sync server listening on 127.0.0.1",
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, "shutting down");
      void app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
} catch (err) {
  // Config/startup failures: fail fast with the message only (no stack noise).
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
