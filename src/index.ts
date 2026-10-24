import "dotenv/config";
import { buildApp } from "./app.js";
import { ActionpackdClient } from "./channels/whatsapp/client.js";
import { WhatsAppAdapter } from "./channels/whatsapp/adapter.js";
import { ChannelRegistry } from "./channels/registry.js";
import { loadConfig } from "./config.js";
import { migrate, migrationsDir } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createPgStore } from "./db/pg-store.js";
import { loggerOptions } from "./logger.js";
import { createMistralAgentClient } from "./mistral/sdk.js";

const config = loadConfig();
const pool = createPool(config);
const store = createPgStore(pool);

try {
  const ran = await migrate(pool, migrationsDir);
  if (ran.length > 0) {
    console.log(`Applied migrations: ${ran.join(", ")}`);
  }
} catch (error) {
  console.error("Migration failed", error);
  await pool.end();
  process.exit(1);
}

const channels = new ChannelRegistry([
  new WhatsAppAdapter(
    new ActionpackdClient({
      apiKey: config.ACTIONPACKD_API_KEY,
      baseUrl: config.ACTIONPACKD_BASE_URL,
    }),
  ),
]);

const agent = createMistralAgentClient({
  apiKey: config.MISTRAL_API_KEY,
  agentId: config.MISTRAL_AGENT_ID,
  ...(config.MISTRAL_BASE_URL ? { baseUrl: config.MISTRAL_BASE_URL } : {}),
});

const app = await buildApp({
  config,
  store,
  channels,
  agent,
  logger: loggerOptions(config),
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  await app.inboundIdle();
  await app.close();
  await pool.end();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error }, "shutdown failed");
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error({ err: error }, "server failed to start");
  await pool.end();
  process.exit(1);
}
