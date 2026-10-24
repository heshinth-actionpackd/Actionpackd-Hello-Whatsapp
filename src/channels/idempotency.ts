import { createHash } from "node:crypto";

const SAFE_KEY = /^[A-Za-z0-9._:-]{1,180}$/;

/** Stable per inbound event and reply index, so an Actionpackd retry cannot double-send. */
export function idempotencyKeyFor(eventId: string, index: number): string {
  const raw = `${eventId}:${index}`;
  if (SAFE_KEY.test(raw)) return raw;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 48);
  return `evt_${digest}_${index}`;
}
