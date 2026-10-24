import { describe, expect, it } from "vitest";
import type { ChannelAdapter, OutboundDelivery } from "../src/channels/adapter.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { ActionpackdError } from "../src/channels/whatsapp/client.js";
import { buildApp } from "../src/app.js";
import { callResponse, FakeAgent, textResponse } from "./fake-agent.js";
import { signBody, testConfig } from "./fixture.js";
import { MemoryStore } from "./memory-store.js";

class FakeWhatsApp implements ChannelAdapter {
  readonly channel = "whatsapp" as const;
  readonly sent: OutboundDelivery[] = [];
  fail = false;
  rejectTemplates = false;

  async send(delivery: OutboundDelivery): Promise<void> {
    if (this.fail) throw new Error("send failed");
    if (this.rejectTemplates && delivery.reply.kind === "template") {
      throw new ActionpackdError("rejected", 400, "template not approved");
    }
    this.sent.push(delivery);
  }
}

async function setup(agent = new FakeAgent(() => textResponse("conv_1", "Which dates matter?"))) {
  const store = new MemoryStore();
  const whatsapp = new FakeWhatsApp();
  const app = await buildApp({
    config: testConfig,
    store,
    channels: new ChannelRegistry([whatsapp]),
    agent,
    logger: false,
  });
  return { app, store, whatsapp, agent };
}

function signed(body: unknown, secret = testConfig.ACTIONPACKD_WEBHOOK_SECRET) {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    payload: raw,
    headers: {
      "content-type": "application/json",
      "x-actionpackd-timestamp": timestamp,
      "x-actionpackd-signature-v2": signBody(secret, raw, Number(timestamp)),
    },
  };
}

const inboundBody = {
  id: "evt_1",
  type: "message.inbound",
  data: {
    message: { from: "919876543210", type: "text", text: { body: "I run a bakery" } },
  },
};

describe("webhook and health routes", () => {
  it("reports liveness without a database and readiness from the store", async () => {
    const { app } = await setup();
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);

    const failing = await buildApp({
      config: testConfig,
      store: new MemoryStore({ ping: async () => Promise.reject(new Error("db down")) }),
      channels: new ChannelRegistry([]),
      agent: new FakeAgent(() => textResponse("conv", "hi")),
      logger: false,
    });
    const down = await failing.inject({ method: "GET", url: "/ready" });
    expect(down.statusCode).toBe(503);
    await app.close();
    await failing.close();
  });

  it("rejects a bad signature before it touches the conversation", async () => {
    const { app, store, whatsapp, agent } = await setup();
    const body = signed(inboundBody);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: { ...body.headers, "x-actionpackd-signature-v2": "deadbeef" },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_signature" });
    await app.inboundIdle();
    expect(store.contactWrites).toBe(0);
    expect(whatsapp.sent).toHaveLength(0);
    expect(agent.requests).toHaveLength(0);
    await app.close();
  });

  it("acks 200 before Mistral returns, then sends with the event idempotency key", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new FakeAgent(async () => {
      await gate;
      return textResponse("conv_1", "Which dates matter?");
    });
    const { app, whatsapp } = await setup(agent);
    const request = signed(inboundBody);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: request.headers,
      payload: request.payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(whatsapp.sent).toHaveLength(0);

    if (!release) throw new Error("gate was not installed");
    release();
    await app.inboundIdle();
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]?.idempotencyKey).toBe("evt_1:0");
    expect(whatsapp.sent[0]?.reply).toMatchObject({ kind: "text", body: "Which dates matter?" });
    await app.close();
  });

  it("runs a duplicate delivery once", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new FakeAgent(async () => {
      await gate;
      return textResponse("conv_1", "Which dates matter?");
    });
    const { app, whatsapp } = await setup(agent);
    const request = signed(inboundBody);
    const first = app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: request.headers,
      payload: request.payload,
    });
    const second = app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: request.headers,
      payload: request.payload,
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    if (!release) throw new Error("gate was not installed");
    release();
    await app.inboundIdle();
    expect(agent.requests).toHaveLength(1);
    expect(whatsapp.sent).toHaveLength(1);

    const third = await app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: request.headers,
      payload: request.payload,
    });
    expect(third.statusCode).toBe(200);
    await app.inboundIdle();
    expect(agent.requests).toHaveLength(1);
    expect(whatsapp.sent).toHaveLength(1);
    await app.close();
  });

  it("keeps the event retryable when the send fails", async () => {
    const { app, store, whatsapp, agent } = await setup();
    whatsapp.fail = true;
    const request = signed(inboundBody);
    const failed = await app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: request.headers,
      payload: request.payload,
    });
    expect(failed.statusCode).toBe(200);
    await app.inboundIdle();
    expect(store.events.get("evt_1")?.status).toBe("processing");
    expect(whatsapp.sent).toHaveLength(0);

    whatsapp.fail = false;
    const retried = await app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: request.headers,
      payload: request.payload,
    });
    expect(retried.statusCode).toBe(200);
    await app.inboundIdle();
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]?.idempotencyKey).toBe("evt_1:0");
    expect(store.events.get("evt_1")?.status).toBe("processed");
    expect(agent.requests).toHaveLength(1);
    expect(store.contactWrites).toBe(1);
    await app.close();
  });

  it("answers 500 when the event cannot be claimed", async () => {
    const { app, store, agent } = await setup();
    store.failTransact = true;
    const request = signed(inboundBody);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: request.headers,
      payload: request.payload,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "unavailable" });
    await app.inboundIdle();
    expect(agent.requests).toHaveLength(0);
    await app.close();
  });

  it("records a status event without creating a contact", async () => {
    const { app, store, whatsapp } = await setup();
    const request = signed({
      id: "evt_status",
      type: "message.status",
      data: { status: { status: "delivered" } },
    });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: request.headers,
      payload: request.payload,
    });
    expect(response.statusCode).toBe(200);
    expect(store.contacts.size).toBe(0);
    expect(store.events.get("evt_status")?.status).toBe("processed");
    expect(whatsapp.sent).toHaveLength(0);
    await app.close();
  });

  it("sends the numbered menu when the menu template is rejected", async () => {
    const { app, whatsapp, agent } = await setup();
    whatsapp.rejectTemplates = true;
    const request = signed({
      id: "evt_menu",
      type: "message.inbound",
      data: { message: { from: "919876543210", type: "text", text: { body: "Hi" } } },
    });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: request.headers,
      payload: request.payload,
    });
    expect(response.statusCode).toBe(200);
    await app.inboundIdle();
    expect(agent.requests).toHaveLength(0);
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]?.reply.kind === "text" && whatsapp.sent[0].reply.body).toContain(
      "Talk to the team",
    );
    await app.close();
  });

  it("executes a handoff tool from the webhook path", async () => {
    const agent = new FakeAgent((request, call) => {
      if (call === 1) {
        return callResponse("conv_1", [
          {
            toolCallId: "hand",
            name: "handoff_to_team",
            arguments: { summary: "Wants to talk about Media Agents" },
          },
        ]);
      }
      return textResponse("conv_2", "The team has this.");
    });
    const { app, store, whatsapp } = await setup(agent);
    const request = signed({
      id: "evt_hand",
      type: "message.inbound",
      data: {
        message: {
          from: "919876543210",
          type: "button",
          button: { payload: "Talk to the team", text: "Talk to the team" },
        },
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/actionpackd",
      headers: request.headers,
      payload: request.payload,
    });
    expect(response.statusCode).toBe(200);
    await app.inboundIdle();
    expect((await store.getContact("919876543210"))?.humanTakeover).toBe(true);
    expect(whatsapp.sent.map((item) => item.to)).toEqual([
      "919876543210",
      testConfig.TEAM_WHATSAPP_NUMBER,
    ]);
    await app.close();
  });
});
