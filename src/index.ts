import "dotenv/config";
import { buildApp } from "./app.js";
import { ActionpackdClient } from "./channels/whatsapp/client.js";
import { WhatsAppAdapter } from "./channels/whatsapp/adapter.js";
import { ChannelRegistry } from "./channels/registry.js";
import { loadConfig } from "./config.js";
import { migrate, migrationsDir } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createPgStore } from "./db/pg-store.js";
import { createGeminiAgentClient } from "./gemini/client.js";
import { loadSystemInstruction } from "./gemini/instructions.js";
import { loggerOptions } from "./logger.js";

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

let systemInstruction: string;
try {
  systemInstruction = loadSystemInstruction();
} catch (error) {
  console.error("Could not load agent/instructions.md", error);
  await pool.end();
  process.exit(1);
}

const agent = createGeminiAgentClient({
  apiKey: config.GEMINI_API_KEY,
  model: config.GEMINI_MODEL,
  systemInstruction,
  store,
  historyTurns: config.GEMINI_HISTORY_TURNS,
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
