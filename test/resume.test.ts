import { describe, expect, it } from "vitest";
import { inboundFromPayload } from "../src/db/pg-store.js";
import type { InboundMessage } from "../src/domain.js";
import { MemoryStore } from "./memory-store.js";

const message: InboundMessage = {
  channel: "whatsapp",
  eventId: "evt_1",
  channelUserId: "919876543210",
  phone: "919876543210",
  text: "Hi",
  buttonId: null,
};

describe("interrupted turns", () => {
  it("returns a claimed inbound message until the event is processed", async () => {
    const store = new MemoryStore();
    await store.transact((tx) => tx.beginEvent(message.eventId, message.channel, message));
    await store.transact((tx) => tx.beginEvent("evt_status", "whatsapp"));
    expect(await store.listInterrupted()).toEqual([message]);
    await store.markEventProcessed(message.eventId);
    expect(await store.listInterrupted()).toEqual([]);
  });

  it("reads a stored payload and rejects a partial one", () => {
    expect(inboundFromPayload(message)).toEqual(message);
    expect(inboundFromPayload(JSON.stringify(message))).toEqual(message);
    expect(inboundFromPayload({ eventId: "evt_1" })).toBeNull();
  });
});
