import type { InboundMessage } from "../../domain.js";

/**
 * ASSUMPTION: Actionpackd posts an envelope and puts Meta's message object on it.
 * The public docs confirm the event is signed, but not the JSON shape. This parser
 * accepts the envelope below and a Meta Cloud API wrapper if that is what arrives.
 * Compare a real delivery (or POST /v1/webhook/test) and tighten this if it differs.
 *
 *   { "id": "evt_...", "type": "message.inbound" | "message.status",
 *     "data": { "message": { ...Meta message } } }
 */
export type ParsedActionpackdEvent =
  | { kind: "inbound"; message: InboundMessage }
  | { kind: "status"; eventId: string }
  | { kind: "ignore"; eventId: string | null; type: string | null }
  | {
      kind: "invalid";
      reason: "invalid_payload" | "missing_message" | "missing_sender" | "missing_event_id";
    };

export function parseActionpackdWebhook(body: unknown): ParsedActionpackdEvent {
  if (!isRecord(body)) return { kind: "invalid", reason: "invalid_payload" };

  const type = readString(body.type) ?? readString(body.event);
  const eventId = readString(body.id) ?? readString(body.event_id) ?? readString(body.eventId);

  if (type === "message.status") {
    if (!eventId) return { kind: "ignore", eventId: null, type };
    return { kind: "status", eventId };
  }

  if (type !== "message.inbound") {
    return { kind: "ignore", eventId, type };
  }

  const meta = findMetaMessage(body);
  if (!meta) return { kind: "invalid", reason: "missing_message" };

  const from = readString(meta.from);
  if (!from) return { kind: "invalid", reason: "missing_sender" };
  const phone = normalizePhone(from);
  if (!phone) return { kind: "invalid", reason: "missing_sender" };

  const id = eventId ?? readString(meta.id);
  if (!id) return { kind: "invalid", reason: "missing_event_id" };

  const button = readButton(meta);
  const text = readText(meta) ?? button.title;

  const message: InboundMessage = {
    channel: "whatsapp",
    eventId: id,
    channelUserId: phone,
    phone,
    text,
    buttonId: button.id,
  };
  return { kind: "inbound", message };
}

export function normalizePhone(input: string): string {
  return input.replace(/\D/g, "");
}

function findMetaMessage(body: Record<string, unknown>): Record<string, unknown> | null {
  const candidates = [
    dig(body, ["data", "message"]),
    dig(body, ["message"]),
    dig(body, ["data", "entry", 0, "changes", 0, "value", "messages", 0]),
    dig(body, ["entry", 0, "changes", 0, "value", "messages", 0]),
    dig(body, ["data", "value", "messages", 0]),
    body.data,
  ];
  for (const candidate of candidates) {
    if (isMetaMessage(candidate)) return candidate;
  }
  return null;
}

function isMetaMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.from === "string";
}

function readText(message: Record<string, unknown>): string | null {
  const text = message.text;
  if (!isRecord(text)) return null;
  return readString(text.body);
}

function readButton(message: Record<string, unknown>): { id: string | null; title: string | null } {
  const button = message.button;
  if (isRecord(button)) {
    return { id: readString(button.payload), title: readString(button.text) };
  }
  const interactive = message.interactive;
  if (isRecord(interactive)) {
    const reply = isRecord(interactive.button_reply)
      ? interactive.button_reply
      : isRecord(interactive.list_reply)
        ? interactive.list_reply
        : null;
    if (reply) return { id: readString(reply.id), title: readString(reply.title) };
  }
  return { id: null, title: null };
}

function dig(root: unknown, path: Array<string | number>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
