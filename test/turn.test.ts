import { describe, expect, it } from "vitest";
import { QuotaError } from "../src/agent/types.js";
import type { AgentRequest } from "../src/agent/types.js";
import type { ChannelAdapter, OutboundDelivery } from "../src/channels/adapter.js";
import { deliverAll } from "../src/channels/deliver.js";
import { idempotencyKeyFor } from "../src/channels/idempotency.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { ActionpackdError } from "../src/channels/whatsapp/client.js";
import { MAX_TOOL_ROUNDS } from "../src/conversation/agent-loop.js";
import { FALLBACK_TEXT, QUOTA_TEXT } from "../src/conversation/copy.js";
import { runTurn } from "../src/conversation/run-turn.js";
import { TEMPLATE_NAMES } from "../src/conversation/templates.js";
import type { Delivery } from "../src/domain.js";
import { callResponse, FakeAgent, textResponse } from "./fake-agent.js";
import { inbound, testConfig } from "./fixture.js";
import { MemoryStore } from "./memory-store.js";

const PHONE = "919876543210";
const TEAM = testConfig.TEAM_WHATSAPP_NUMBER;

function userRequest(request: AgentRequest): Extract<AgentRequest, { kind: "user" }> {
  if (request.kind !== "user") throw new Error("expected a user turn");
  return request;
}

async function sendAll(deliveries: Delivery[], sent: OutboundDelivery[], eventId: string) {
  const whatsapp: ChannelAdapter = {
    channel: "whatsapp",
    async send(delivery) {
      sent.push(delivery);
    },
  };
  await deliverAll({
    channels: new ChannelRegistry([whatsapp]),
    eventId,
    deliveries,
    log: { info() {}, warn() {}, error() {} },
  });
}

async function seedHistory(store: MemoryStore): Promise<void> {
  await store.appendMessages(PHONE, [
    { role: "user", parts: [{ text: "old" }] },
    { role: "model", parts: [{ text: "old reply" }] },
  ]);
}

describe("agent turns", () => {
  it("sends the menu template for a greeting and does not call Gemini", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent(() => textResponse("unused"));
    const sent: OutboundDelivery[] = [];
    await runTurn(deps(store, agent), inbound({ eventId: "evt_hi", text: "Hi" }), (deliveries) =>
      sendAll(deliveries, sent, "evt_hi"),
    );
    expect(agent.requests).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.reply).toEqual({
      kind: "template",
      templateName: TEMPLATE_NAMES.menu,
      language: "en",
    });
    expect(sent[0]?.idempotencyKey).toBe("evt_hi:0");
    expect((await store.getContact(PHONE))?.lastInboundAt).toBeTruthy();
    expect(await store.listMessages(PHONE, 20)).toEqual([]);
  });

  it("reads a numbered reply to the opening menu as that choice", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((request) => {
      const user = userRequest(request);
      expect(user.text).toBe("Media Agents");
      expect(user.phone).toBe(PHONE);
      return textResponse("Posters, a video, or a voiceover?");
    });
    await runTurn(
      deps(store, agent),
      inbound({ eventId: "evt_num", text: "2" }),
      async () => undefined,
    );
    expect(agent.requests).toHaveLength(1);
    expect(await store.hasMessages(PHONE)).toBe(true);

    const later = new FakeAgent((request) => {
      expect(userRequest(request).text).toBe("2");
      return textResponse("Got it.");
    });
    await runTurn(
      deps(store, later),
      inbound({ eventId: "evt_num_2", text: "2" }),
      async () => undefined,
    );
    expect(later.requests).toHaveLength(1);
  });

  it("passes a button title to the agent and stores the exchange", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((request, call) => {
      const user = userRequest(request);
      if (call === 1) {
        expect(user.text).toBe("Follow-Up Bot");
        return textResponse("What dates matter?");
      }
      expect(user.text).toBe("Birthdays for cake orders");
      return textResponse("Noted.");
    });
    await runTurn(
      deps(store, agent),
      inbound({
        eventId: "evt_btn",
        text: "Follow-Up Bot",
        buttonId: "Follow-Up Bot",
      }),
      async () => undefined,
    );
    expect(await store.listMessages(PHONE, 20)).toHaveLength(2);

    await runTurn(
      deps(store, agent),
      inbound({ eventId: "evt_next", text: "Birthdays for cake orders" }),
      async () => undefined,
    );
    expect(userRequest(agent.requests[1] ?? fail("missing second call")).text).toBe(
      "Birthdays for cake orders",
    );
    expect(await store.listMessages(PHONE, 20)).toHaveLength(4);
  });

  it("saves a lead from a function call, including arguments sent as a JSON string", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((request, call) => {
      if (call === 1) {
        return callResponse([
          {
            toolCallId: "lead_1",
            name: "save_lead",
            arguments:
              '{"name":"Priya","business_type":"B2C bakery","need":"Follow-Up Bot","has_whatsapp_business_number":false}',
          },
        ]);
      }
      const tool = request.kind === "tool_results" ? request : fail("expected tool results");
      expect(tool.phone).toBe(PHONE);
      expect(JSON.parse(tool.results[0]?.result ?? "{}")).toMatchObject({
        ok: true,
        lead: { name: "Priya", has_whatsapp_business_number: false },
      });
      return textResponse("Do you want the team to take this from here?");
    });

    const sent: OutboundDelivery[] = [];
    await runTurn(deps(store, agent), inbound({ eventId: "evt_lead", text: "I'm Priya" }), (d) =>
      sendAll(d, sent, "evt_lead"),
    );

    expect(await store.getLead(PHONE)).toMatchObject({
      name: "Priya",
      businessType: "B2C bakery",
      need: "Follow-Up Bot",
      hasWhatsappBusinessNumber: false,
    });
    expect(sent[0]?.reply).toMatchObject({
      kind: "text",
      body: "Do you want the team to take this from here?",
    });
    expect(JSON.stringify(await store.listMessages(PHONE, 20))).toContain("save_lead");

    const agent2 = new FakeAgent((request, call) => {
      if (call === 1) {
        return callResponse([
          { toolCallId: "lead_2", name: "save_lead", arguments: { notes: "Anniversary cakes" } },
        ]);
      }
      return textResponse("Noted.");
    });
    await runTurn(
      deps(store, agent2),
      inbound({ eventId: "evt_note", text: "Also anniversary cakes" }),
      async () => undefined,
    );
    expect(await store.getLead(PHONE)).toMatchObject({
      name: "Priya",
      hasWhatsappBusinessNumber: false,
      notes: "Anniversary cakes",
    });
  });

  it("returns invalid tool arguments to the agent and does not save an empty lead", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((request, call) => {
      if (call === 1) {
        return callResponse([{ toolCallId: "bad", name: "save_lead", arguments: {} }]);
      }
      const tool = request.kind === "tool_results" ? request : fail("expected tool results");
      expect(tool.results[0]?.result).toContain("nothing_to_save");
      return textResponse("What's your name?");
    });
    await runTurn(
      deps(store, agent),
      inbound({ eventId: "evt_bad", text: "hello there" }),
      async () => undefined,
    );
    expect(await store.getLead(PHONE)).toBeNull();
    expect(agent.requests).toHaveLength(2);
  });

  it("hands the chat to the team, then stays quiet until BOT ON", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((request, call) => {
      if (call === 1) {
        return callResponse([
          {
            toolCallId: "save",
            name: "save_lead",
            arguments: { name: "Priya", business_type: "B2C bakery", need: "Follow-Up Bot" },
          },
          {
            toolCallId: "hand",
            name: "handoff_to_team",
            arguments: { summary: "Priya\nruns a B2C bakery and wants the Follow-Up Bot." },
          },
        ]);
      }
      return textResponse("The team has this. They'll message you here.");
    });
    const sent: OutboundDelivery[] = [];
    await runTurn(
      deps(store, agent),
      inbound({ eventId: "evt_hand", text: "Talk to the team" }),
      (d) => sendAll(d, sent, "evt_hand"),
    );

    expect((await store.getContact(PHONE))?.humanTakeover).toBe(true);
    expect(sent.map((delivery) => delivery.to)).toEqual([PHONE, TEAM]);
    expect(sent[1]?.reply).toMatchObject({
      kind: "template",
      templateName: TEMPLATE_NAMES.teamAlert,
    });
    if (sent[1]?.reply.kind === "template") {
      expect(sent[1].reply.bodyParams?.[0]).toBe(PHONE);
      expect(sent[1].reply.bodyParams?.[1]).toBe(
        "Priya runs a B2C bakery and wants the Follow-Up Bot.",
      );
    }
    expect(sent[0]?.idempotencyKey).toBe("evt_hand:0");
    expect(sent[1]?.idempotencyKey).toBe("evt_hand:1");
    const remembered = (await store.listMessages(PHONE, 20)).length;
    expect(remembered).toBeGreaterThan(0);

    const quiet = new FakeAgent(() => textResponse("should not run"));
    const quietSent: OutboundDelivery[] = [];
    await runTurn(deps(store, quiet), inbound({ eventId: "evt_quiet", text: "start over" }), (d) =>
      sendAll(d, quietSent, "evt_quiet"),
    );
    expect(quiet.requests).toHaveLength(0);
    expect(quietSent).toHaveLength(0);
    expect((await store.getContact(PHONE))?.humanTakeover).toBe(true);
    expect(await store.listMessages(PHONE, 20)).toHaveLength(remembered);

    const teamSent: OutboundDelivery[] = [];
    await runTurn(
      deps(store, quiet),
      inbound({
        eventId: "evt_on",
        phone: TEAM,
        channelUserId: TEAM,
        text: "BOT ON +91 98765 43210",
      }),
      (d) => sendAll(d, teamSent, "evt_on"),
    );
    expect(quiet.requests).toHaveLength(0);
    expect(teamSent[0]?.reply).toMatchObject({ kind: "text" });
    expect(teamSent[0]?.reply.kind === "text" && teamSent[0].reply.body).toContain(PHONE);
    expect((await store.getContact(PHONE))?.humanTakeover).toBe(false);
    expect(await store.getContact(TEAM)).toBeNull();

    const resumed = new FakeAgent(() => textResponse("Still with you."));
    await runTurn(
      deps(store, resumed),
      inbound({ eventId: "evt_back", text: "One more thing" }),
      async () => undefined,
    );
    expect(resumed.requests).toHaveLength(1);
    expect(await store.listMessages(PHONE, 20)).toHaveLength(remembered + 2);
  });

  it("tells the team how to turn the bot on, and ignores other team messages", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent(() => textResponse("nope"));
    const sent: OutboundDelivery[] = [];
    await runTurn(
      deps(store, agent),
      inbound({ eventId: "evt_team", phone: TEAM, channelUserId: TEAM, text: "hello" }),
      (d) => sendAll(d, sent, "evt_team"),
    );
    expect(agent.requests).toHaveLength(0);
    expect(sent[0]?.reply.kind === "text" && sent[0].reply.body).toContain("BOT ON");

    await runTurn(
      deps(store, agent),
      inbound({
        eventId: "evt_missing",
        phone: TEAM,
        channelUserId: TEAM,
        text: "BOT ON 15551212",
      }),
      (d) => sendAll(d, sent, "evt_missing"),
    );
    expect(sent[1]?.reply.kind === "text" && sent[1].reply.body).toContain("15551212");
  });

  it("clears history on start over, restart, and menu", async () => {
    const store = new MemoryStore();
    store.contacts.set(PHONE, {
      phone: PHONE,
      channel: "whatsapp",
      humanTakeover: false,
      lastInboundAt: null,
    });
    const agent = new FakeAgent(() => textResponse("Reminders for a clinic."));

    for (const [eventId, text] of [
      ["evt_so", "start over"],
      ["evt_re", "Restart!"],
      ["evt_menu", "menu"],
    ] as const) {
      await seedHistory(store);
      const sent: OutboundDelivery[] = [];
      await runTurn(deps(store, agent), inbound({ eventId, text }), (d) =>
        sendAll(d, sent, eventId),
      );
      expect(sent[0]?.reply).toMatchObject({
        kind: "template",
        templateName: TEMPLATE_NAMES.menu,
      });
      expect(await store.listMessages(PHONE, 20)).toEqual([]);
    }
    expect(agent.requests).toHaveLength(0);

    await runTurn(
      deps(store, agent),
      inbound({ eventId: "evt_fresh", text: "I need reminders for my clinic" }),
      async () => undefined,
    );
    expect(agent.requests).toHaveLength(1);
    expect(await store.listMessages(PHONE, 20)).toHaveLength(2);
  });

  it("clears history when the agent calls start_over", async () => {
    const store = new MemoryStore();
    await seedHistory(store);
    const agent = new FakeAgent((request, call) => {
      if (call === 1) {
        expect(userRequest(request).text).toBe("can we start again?");
        return callResponse([{ toolCallId: "reset", name: "start_over", arguments: {} }]);
      }
      expect(request.kind).toBe("tool_results");
      return textResponse("Fresh start.\n1. Business Agents");
    });
    const sent: OutboundDelivery[] = [];
    await runTurn(
      deps(store, agent),
      inbound({ eventId: "evt_reset_tool", text: "can we start again?" }),
      (d) => sendAll(d, sent, "evt_reset_tool"),
    );
    expect(await store.listMessages(PHONE, 20)).toEqual([]);
    expect(sent[0]?.reply).toMatchObject({
      kind: "text",
      body: "Fresh start.\n1. Business Agents",
    });
  });

  it("sends a fallback reply when Gemini fails", async () => {
    const store = new MemoryStore();
    const failing = new FakeAgent(() => {
      throw new Error("timeout");
    });
    const sent: OutboundDelivery[] = [];
    await runTurn(deps(store, failing), inbound({ eventId: "evt_fail", text: "plans?" }), (d) =>
      sendAll(d, sent, "evt_fail"),
    );
    expect(sent[0]?.reply).toEqual({ kind: "text", body: FALLBACK_TEXT });
    expect(await store.listMessages(PHONE, 20)).toEqual([
      { role: "user", parts: [{ text: "plans?" }] },
      { role: "model", parts: [{ text: FALLBACK_TEXT }] },
    ]);
  });

  it("keeps a handoff when the follow-up call fails", async () => {
    const store = new MemoryStore();
    const stale = new FakeAgent((request, call) => {
      if (call === 1) {
        return callResponse([
          { toolCallId: "hand", name: "handoff_to_team", arguments: { summary: "Wants pricing" } },
        ]);
      }
      throw new Error("tool append failed");
    });
    await runTurn(
      deps(store, stale),
      inbound({ eventId: "evt_stale", text: "Talk to the team" }),
      async () => undefined,
    );
    expect((await store.getContact(PHONE))?.humanTakeover).toBe(true);
    const messages = await store.listMessages(PHONE, 20);
    expect(messages).toEqual([
      { role: "user", parts: [{ text: "Talk to the team" }] },
      { role: "model", parts: [{ text: FALLBACK_TEXT }] },
    ]);
  });

  it("replies once when Gemini is out of quota and does not retry", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((request, call) => {
      if (call === 1) {
        return callResponse([
          { toolCallId: "lead_1", name: "save_lead", arguments: { name: "Priya" } },
        ]);
      }
      throw new QuotaError();
    });
    const sent: OutboundDelivery[] = [];
    await runTurn(deps(store, agent), inbound({ eventId: "evt_quota", text: "I'm Priya" }), (d) =>
      sendAll(d, sent, "evt_quota"),
    );
    expect(agent.requests).toHaveLength(2);
    expect(sent[0]?.reply).toEqual({ kind: "text", body: QUOTA_TEXT });
    expect((await store.getLead(PHONE))?.name).toBe("Priya");
    const stored = JSON.stringify(await store.listMessages(PHONE, 20));
    expect(stored).toContain(QUOTA_TEXT);
    expect(stored).not.toContain("functionCall");
  });

  it("stores the parts the agent returned, including a thought signature", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent((request, call) => {
      if (call === 1) {
        return {
          outputs: [
            {
              type: "function_call",
              call: { toolCallId: "fc", name: "save_lead", arguments: { name: "Priya" } },
            },
          ],
          messages: [
            { role: "user", parts: [{ text: "I'm Priya" }] },
            {
              role: "model",
              parts: [
                {
                  thoughtSignature: "sig",
                  functionCall: { name: "save_lead", id: "fc", args: { name: "Priya" } },
                },
              ],
            },
          ],
        };
      }
      return {
        outputs: [{ type: "text", text: "Noted." }],
        messages: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "save_lead",
                  id: "fc",
                  response: { output: { ok: true } },
                },
              },
            ],
          },
          { role: "model", parts: [{ text: "Noted.", thoughtSignature: "sig2" }] },
        ],
      };
    });
    await runTurn(
      deps(store, agent),
      inbound({ eventId: "evt_sig", text: "I'm Priya" }),
      async () => undefined,
    );
    const stored = JSON.stringify(await store.listMessages(PHONE, 20));
    expect(stored).toContain("sig");
    expect(stored).toContain("sig2");
    expect(stored).toContain("functionResponse");
  });

  it("stops calling tools after the round cap", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent(() =>
      callResponse([{ toolCallId: "again", name: "save_lead", arguments: { name: "Priya" } }]),
    );
    const sent: OutboundDelivery[] = [];
    await runTurn(deps(store, agent), inbound({ eventId: "evt_loop", text: "keep going" }), (d) =>
      sendAll(d, sent, "evt_loop"),
    );
    expect(agent.requests).toHaveLength(1 + MAX_TOOL_ROUNDS);
    expect(sent[0]?.reply).toEqual({ kind: "text", body: FALLBACK_TEXT });
    expect((await store.getLead(PHONE))?.name).toBe("Priya");
  });

  it("applies an event once and resends the same deliveries until the send succeeds", async () => {
    const store = new MemoryStore();
    const agent = new FakeAgent(() => textResponse("Which dates matter?"));
    let fail = true;
    const sent: OutboundDelivery[] = [];
    const deliver = async (deliveries: Delivery[]) => {
      if (fail) throw new Error("send failed");
      await sendAll(deliveries, sent, "evt_1");
    };

    await expect(
      runTurn(
        deps(store, agent),
        inbound({ eventId: "evt_1", text: "I need the reminder bot" }),
        deliver,
      ),
    ).rejects.toThrow(/send failed/);
    expect(store.events.get("evt_1")?.status).toBe("processing");
    expect(agent.requests).toHaveLength(1);
    expect(await store.listMessages(PHONE, 20)).toHaveLength(2);

    fail = false;
    await runTurn(
      deps(store, agent),
      inbound({ eventId: "evt_1", text: "I need the reminder bot" }),
      deliver,
    );
    expect(agent.requests).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.idempotencyKey).toBe("evt_1:0");
    expect(store.events.get("evt_1")?.status).toBe("processed");
    expect(store.contactWrites).toBe(1);
    expect(await store.listMessages(PHONE, 20)).toHaveLength(2);

    await runTurn(
      deps(store, agent),
      inbound({ eventId: "evt_1", text: "something else" }),
      deliver,
    );
    expect(agent.requests).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(await store.listMessages(PHONE, 20)).toHaveLength(2);
  });

  it("builds a stable Actionpackd idempotency key from the event id", () => {
    expect(idempotencyKeyFor("evt_1", 0)).toBe("evt_1:0");
    expect(idempotencyKeyFor("has spaces", 1)).toMatch(/^evt_[0-9a-f]{48}_1$/);
  });

  it("falls back to text when a template send is rejected", async () => {
    const warnings: string[] = [];
    const sent: OutboundDelivery[] = [];
    const whatsapp: ChannelAdapter = {
      channel: "whatsapp",
      async send(delivery) {
        if (delivery.reply.kind === "template") {
          throw new ActionpackdError("rejected", 400, "template not approved");
        }
        sent.push(delivery);
      },
    };
    await deliverAll({
      channels: new ChannelRegistry([whatsapp]),
      eventId: "evt_menu",
      deliveries: [
        {
          channel: "whatsapp",
          to: PHONE,
          reply: { kind: "template", templateName: TEMPLATE_NAMES.menu, language: "en" },
        },
      ],
      log: {
        info() {},
        error() {},
        warn(_bindings, message) {
          warnings.push(message);
        },
      },
    });
    expect(warnings).toEqual(["template send failed; sending text instead"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.idempotencyKey).toBe("evt_menu:fallback:0");
    expect(sent[0]?.reply.kind === "text" && sent[0].reply.body).toContain("1. Business Agents");
  });
});

function deps(store: MemoryStore, agent: FakeAgent) {
  return { store, agent, teamPhone: TEAM };
}

function fail(message: string): never {
  throw new Error(message);
}
