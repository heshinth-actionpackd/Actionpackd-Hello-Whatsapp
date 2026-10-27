import { describe, expect, it } from "vitest";
import { ActionpackdClient, messagesUrl } from "../src/channels/whatsapp/client.js";

describe("Actionpackd send client", () => {
  it("posts text to /v1/messages with a bearer key and idempotency key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "msg_1", status: "queued" }), { status: 202 });
    };
    const client = new ActionpackdClient({
      apiKey: "apk_test_unit",
      baseUrl: "https://api.actionpackd.com/v1",
      fetchImpl,
    });

    await client.sendMessage({
      to: "919876543210",
      idempotencyKey: "evt_1:0",
      reply: { kind: "text", body: "Welcome" },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected a request");
    expect(call.url).toBe("https://api.actionpackd.com/v1/messages");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer apk_test_unit");
    expect(headers.get("idempotency-key")).toBe("evt_1:0");
    expect(JSON.parse(String(call.init.body))).toEqual({
      to: "919876543210",
      type: "text",
      text: { body: "Welcome" },
    });
  });

  it("sends a template without components when it has no parameters", async () => {
    let body: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    };
    const client = new ActionpackdClient({
      apiKey: "apk_test_unit",
      baseUrl: "https://api.actionpackd.com/v1/",
      fetchImpl,
    });
    await client.sendMessage({
      to: "919876543210",
      idempotencyKey: "evt_1:0",
      reply: { kind: "template", templateName: "hello_menu", language: "en" },
    });
    expect(body).toEqual({
      to: "919876543210",
      type: "template",
      template: { name: "hello_menu", language: "en" },
    });
  });

  it("sends template body parameters for the team alert", async () => {
    let body: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 202 });
    };
    const client = new ActionpackdClient({
      apiKey: "apk_test_unit",
      baseUrl: "https://api.actionpackd.com/v1",
      fetchImpl,
    });
    await client.sendMessage({
      to: "919800000000",
      idempotencyKey: "evt_1:1",
      reply: {
        kind: "template",
        templateName: "hello_team_alert",
        language: "en",
        bodyParams: ["919876543210", "Bakery wants the Follow-Up Bot"],
      },
    });
    expect(body).toEqual({
      to: "919800000000",
      type: "template",
      template: {
        name: "hello_team_alert",
        language: "en",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "919876543210" },
              { type: "text", text: "Bakery wants the Follow-Up Bot" },
            ],
          },
        ],
      },
    });
  });

  it("joins the base URL even when it has no trailing slash", () => {
    expect(messagesUrl("https://api.actionpackd.com/v1")).toBe(
      "https://api.actionpackd.com/v1/messages",
    );
  });

  it("surfaces a non-success status", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "window", code: "SESSION_WINDOW_CLOSED" }), {
        status: 409,
      });
    const client = new ActionpackdClient({
      apiKey: "apk_test_unit",
      baseUrl: "https://api.actionpackd.com/v1",
      fetchImpl,
    });
    await expect(
      client.sendMessage({
        to: "919876543210",
        idempotencyKey: "evt_1:0",
        reply: { kind: "text", body: "Hi" },
      }),
    ).rejects.toThrow(/409/);
  });
});
