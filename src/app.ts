import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import type { ChannelRegistry } from "./channels/registry.js";
import { registerWhatsappWebhook } from "./channels/whatsapp/routes.js";
import type { AppConfig } from "./config.js";
import { InFlight } from "./inflight.js";
import type { AgentClient } from "./mistral/types.js";
import { registerHealthRoutes } from "./routes/health.js";
import type { HelloStore } from "./store.js";

export interface BuildAppOptions {
  config: AppConfig;
  store: HelloStore;
  channels: ChannelRegistry;
  agent: AgentClient;
  inFlight?: InFlight;
  logger?: FastifyServerOptions["logger"] | false;
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: options.logger ?? false,
  });
  const inFlight = options.inFlight ?? new InFlight();
  app.decorate("inboundIdle", () => inFlight.idle());

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
    request.rawBody = raw;
    if (raw.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw.toString("utf8")) as unknown);
    } catch {
      const error = new Error("invalid_json") as FastifyError;
      error.statusCode = 400;
      done(error);
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
      return reply.code(statusCode).send({ error: "internal_error" });
    }
    return reply.code(statusCode).send({ error: error.message });
  });

  registerHealthRoutes(app, options.store);
  registerWhatsappWebhook(app, {
    config: options.config,
    store: options.store,
    channels: options.channels,
    agent: options.agent,
    inFlight,
  });

  return app;
}
