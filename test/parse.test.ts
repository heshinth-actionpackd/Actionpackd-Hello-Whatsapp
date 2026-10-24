import { describe, expect, it } from "vitest";
import { parseActionpackdWebhook } from "../src/channels/whatsapp/parse.js";

describe("Actionpackd webhook parser", () => {
  it("reads a text message from the assumed envelope", () => {
    const parsed = parseActionpackdWebhook({
      id: "evt_1",
      type: "message.inbound",
      data: {
        message: {
          from: "+91 98765 43210",
          id: "wamid.1",
          type: "text",
          text: { body: "Hi" },
        },
      },
    });

    expect(parsed).toEqual({
      kind: "inbound",
      message: {
        channel: "whatsapp",
        eventId: "evt_1",
        channelUserId: "919876543210",
        phone: "919876543210",
        text: "Hi",
        buttonId: null,
      },
    });
  });

  it("reads a template quick-reply button and a Cloud API wrapper", () => {
    const button = parseActionpackdWebhook({
      id: "evt_2",
      type: "message.inbound",
      data: {
        message: {
          from: "919876543210",
          type: "button",
          button: { payload: "Follow-Up Bot", text: "Follow-Up Bot" },
        },
      },
    });
    expect(button.kind === "inbound" && button.message.buttonId).toBe("Follow-Up Bot");
    expect(button.kind === "inbound" && button.message.text).toBe("Follow-Up Bot");

    const wrapped = parseActionpackdWebhook({
      id: "evt_3",
      type: "message.inbound",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: "15551212", type: "text", text: { body: "hello" } }],
              },
            },
          ],
        },
      ],
    });
    expect(wrapped.kind === "inbound" && wrapped.message.text).toBe("hello");
    expect(wrapped.kind === "inbound" && wrapped.message.phone).toBe("15551212");
  });

  it("acks status events and ignores unknown types", () => {
    expect(
      parseActionpackdWebhook({ id: "evt_s", type: "message.status", data: { status: {} } }),
    ).toEqual({
      kind: "status",
      eventId: "evt_s",
    });
    expect(parseActionpackdWebhook({ id: "evt_t", type: "webhook.test" })).toEqual({
      kind: "ignore",
      eventId: "evt_t",
      type: "webhook.test",
    });
    expect(parseActionpackdWebhook({ type: "message.inbound", data: {} })).toEqual({
      kind: "invalid",
      reason: "missing_message",
    });
  });
});
