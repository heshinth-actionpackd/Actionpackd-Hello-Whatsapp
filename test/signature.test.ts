import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SIGNATURE_MAX_SKEW_SECONDS,
  verifyActionpackdSignature,
} from "../src/channels/whatsapp/signature.js";

const secret = "whsec_test";
const rawBody = Buffer.from('{"id":"evt_1","type":"message.inbound"}');
const now = new Date("2026-06-01T12:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

function macHex(timestamp: number, body: Buffer = rawBody, key = secret): string {
  const payload = Buffer.concat([Buffer.from(String(timestamp)), Buffer.from("."), body]);
  return createHmac("sha256", key).update(payload).digest("hex");
}

function verify(overrides: Partial<Parameters<typeof verifyActionpackdSignature>[0]> = {}) {
  const timestamp = overrides.timestampHeader ?? String(nowSeconds);
  return verifyActionpackdSignature({
    rawBody,
    signatureHeader: macHex(Number(timestamp)),
    timestampHeader: String(nowSeconds),
    secret,
    now,
    ...overrides,
  });
}

describe("Actionpackd signature v2", () => {
  it("accepts the HMAC of timestamp and raw body", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("accepts a sha256= prefix and uppercase hex", () => {
    const hex = macHex(nowSeconds);
    expect(verify({ signatureHeader: `sha256=${hex.toUpperCase()}` })).toEqual({ ok: true });
  });

  it("accepts the same MAC in base64", () => {
    const payload = Buffer.concat([Buffer.from(String(nowSeconds)), Buffer.from("."), rawBody]);
    const b64 = createHmac("sha256", secret).update(payload).digest("base64");
    expect(verify({ signatureHeader: b64 })).toEqual({ ok: true });
  });

  it("rejects a missing signature, a missing timestamp, and a wrong secret", () => {
    expect(verify({ signatureHeader: undefined }).ok).toBe(false);
    expect(verify({ timestampHeader: undefined })).toEqual({
      ok: false,
      reason: "missing_timestamp",
    });
    expect(verify({ signatureHeader: macHex(nowSeconds, rawBody, "other") })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a body that does not match the signed bytes", () => {
    expect(verify({ rawBody: Buffer.from('{"id":"evt_1","type":"message.inbound"} ') })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects timestamps outside the 5 minute window", () => {
    const expired = nowSeconds - SIGNATURE_MAX_SKEW_SECONDS - 1;
    const future = nowSeconds + SIGNATURE_MAX_SKEW_SECONDS + 1;
    const edge = nowSeconds - SIGNATURE_MAX_SKEW_SECONDS;

    expect(verify({ signatureHeader: macHex(expired), timestampHeader: String(expired) })).toEqual({
      ok: false,
      reason: "timestamp_expired",
    });
    expect(verify({ signatureHeader: macHex(future), timestampHeader: String(future) })).toEqual({
      ok: false,
      reason: "timestamp_skew",
    });
    expect(verify({ signatureHeader: macHex(edge), timestampHeader: String(edge) })).toEqual({
      ok: true,
    });
  });
});
