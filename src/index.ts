import "dotenv/config";
import { buildApp } from "./app.js";
import { deliverAll } from "./channels/deliver.js";
import { logTurnFailure } from "./channels/whatsapp/routes.js";
import { ActionpackdClient } from "./channels/whatsapp/client.js";
import { WhatsAppAdapter } from "./channels/whatsapp/adapter.js";
import { ChannelRegistry } from "./channels/registry.js";
import { loadConfig } from "./config.js";
import { runTurn } from "./conversation/run-turn.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createPgStore } from "./db/pg-store.js";
import type { InboundMessage } from "./domain.js";
import { createGeminiAgentClient } from "./gemini/client.js";
import { loadSystemInstruction } from "./gemini/instructions.js";
import { InFlight } from "./inflight.js";
import type { Log } from "./log.js";
import { loggerOptions } from "./logger.js";

const config = loadConfig();
const pool = createPool(config);
const store = createPgStore(pool);

try {
  await migrate(pool);
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

const inFlight = new InFlight();
const app = await buildApp({
  config,
  store,
  channels,
  agent,
  inFlight,
  logger: loggerOptions(config),
});
const log: Log = {
  info: (bindings, message) => app.log.info(bindings, message),
  warn: (bindings, message) => app.log.warn(bindings, message),
  error: (bindings, message) => app.log.error(bindings, message),
};

function resume(message: InboundMessage): Promise<void> {
  return runTurn(
    { store, agent, teamPhone: config.TEAM_WHATSAPP_NUMBER, log },
    message,
    (deliveries) =>
      deliverAll({
        channels,
        eventId: message.eventId,
        deliveries,
        log,
      }),
  ).catch((error: unknown) => {
    logTurnFailure(error, log, message.eventId);
  });
}

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

try {
  const interrupted = await store.listInterrupted();
  for (const message of interrupted) {
    app.log.info({ eventId: message.eventId }, "resuming interrupted turn");
    inFlight.track(resume(message));
  }
} catch (error) {
  app.log.error({ err: error }, "could not resume interrupted turns");
}
