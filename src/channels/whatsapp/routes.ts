import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { deliverAll } from "../deliver.js";
import type { ChannelRegistry } from "../registry.js";
import type { AppConfig } from "../../config.js";
import { acceptInbound, runTurn } from "../../conversation/run-turn.js";
import type { InFlight } from "../../inflight.js";
import type { Log } from "../../log.js";
import type { AgentClient } from "../../agent/types.js";
import type { HelloStore } from "../../store.js";
import { ActionpackdError, actionpackdErrorCode } from "./client.js";
import { parseActionpackdWebhook } from "./parse.js";
import { verifyActionpackdSignature } from "./signature.js";

export const ACTIONPACKD_WEBHOOK_PATH = "/webhooks/actionpackd";

export function registerWhatsappWebhook(
  app: FastifyInstance,
  deps: {
    config: AppConfig;
    store: HelloStore;
    channels: ChannelRegistry;
    agent: AgentClient;
    inFlight: InFlight;
  },
): void {
  app.post(ACTIONPACKD_WEBHOOK_PATH, async (request, reply) => {
    const rawBody = request.rawBody;
    const verdict = verifyActionpackdSignature({
      rawBody: rawBody ?? Buffer.alloc(0),
      signatureHeader: request.headers["x-actionpackd-signature-v2"],
      timestampHeader: request.headers["x-actionpackd-timestamp"],
      secret: deps.config.ACTIONPACKD_WEBHOOK_SECRET,
    });
    if (!verdict.ok || !rawBody) {
      request.log.warn(
        { reason: verdict.ok ? "missing_body" : verdict.reason },
        "rejected webhook",
      );
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const parsed = parseActionpackdWebhook(request.body);
    if (parsed.kind === "invalid") {
      request.log.warn({ reason: parsed.reason }, "unreadable inbound webhook");
      return reply.code(400).send({ error: parsed.reason });
    }
    if (parsed.kind === "ignore") {
      request.log.info({ eventId: parsed.eventId, type: parsed.type }, "ignored webhook");
      return reply.code(200).send({ ok: true, ignored: true });
    }
    if (parsed.kind === "status") {
      await recordStatus(deps.store, parsed.eventId);
      request.log.info({ eventId: parsed.eventId }, "recorded status webhook");
      return reply.code(200).send({ ok: true });
    }

    const message = parsed.message;
    let gate: "process" | "done";
    try {
      gate = await acceptInbound(deps.store, message);
    } catch (error) {
      request.log.error({ err: error, eventId: message.eventId }, "failed to claim webhook");
      return reply.code(500).send({ error: "unavailable" });
    }
    if (gate === "done") return reply.code(200).send({ ok: true });

    const log = bindLog(request.log);
    const job = runTurn(
      {
        store: deps.store,
        agent: deps.agent,
        teamPhone: deps.config.TEAM_WHATSAPP_NUMBER,
        log,
      },
      message,
      (deliveries) =>
        deliverAll({
          channels: deps.channels,
          eventId: message.eventId,
          deliveries,
          log,
        }),
    ).catch((error: unknown) => {
      logTurnFailure(error, log, message.eventId);
    });
    deps.inFlight.track(job);
    return reply.code(200).send({ ok: true });
  });
}

export function logTurnFailure(error: unknown, log: Log, eventId: string): void {
  if (error instanceof ActionpackdError && error.status === 409) {
    log.error(
      { err: error, eventId, body: error.body, code: actionpackdErrorCode(error.body) },
      "send rejected",
    );
    return;
  }
  log.error({ err: error, eventId }, "inbound turn failed");
}

function bindLog(log: FastifyBaseLogger): Log {
  return {
    info(bindings, message) {
      log.info(bindings, message);
    },
    warn(bindings, message) {
      log.warn(bindings, message);
    },
    error(bindings, message) {
      log.error(bindings, message);
    },
  };
}

async function recordStatus(store: HelloStore, eventId: string): Promise<void> {
  await store.transact(async (tx) => {
    const begun = await tx.beginEvent(eventId, "whatsapp");
    if (begun.status === "new") await tx.saveEventDeliveries(eventId, []);
  });
  await store.markEventProcessed(eventId);
}
