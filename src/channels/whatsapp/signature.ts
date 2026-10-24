import { createHmac, timingSafeEqual } from "node:crypto";

/** Documented Actionpackd v2 window. Reject timestamps older than this, plus the same future skew. */
export const SIGNATURE_MAX_SKEW_SECONDS = 5 * 60;

export type SignatureResult = { ok: true } | { ok: false; reason: string };

/**
 * Actionpackd signs `X-Actionpackd-Signature-V2` as HMAC-SHA256 of
 * `${X-Actionpackd-Timestamp}.${rawBody}`, timestamp in Unix seconds.
 *
 * ASSUMPTION: the header value is the hex digest, optionally prefixed with
 * `sha256=`. Base64 (standard or url-safe) is also accepted so a test delivery
 * still verifies if the console uses that encoding. Confirm with POST /v1/webhook/test.
 */
export function verifyActionpackdSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | string[] | undefined;
  timestampHeader: string | string[] | undefined;
  secret: string;
  now?: Date;
}): SignatureResult {
  const signature = singleHeader(input.signatureHeader);
  const timestamp = singleHeader(input.timestampHeader);
  if (!signature) return { ok: false, reason: "missing_signature" };
  if (!timestamp) return { ok: false, reason: "missing_timestamp" };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "invalid_timestamp" };

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const skew = nowSeconds - timestampSeconds;
  if (skew > SIGNATURE_MAX_SKEW_SECONDS) return { ok: false, reason: "timestamp_expired" };
  if (skew < -SIGNATURE_MAX_SKEW_SECONDS) return { ok: false, reason: "timestamp_skew" };

  const payload = Buffer.concat([Buffer.from(timestamp), Buffer.from("."), input.rawBody]);
  const mac = createHmac("sha256", input.secret).update(payload).digest();
  const provided = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  if (!macMatches(mac, provided)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function macMatches(mac: Buffer, provided: string): boolean {
  const hex = mac.toString("hex");
  if (provided.length === hex.length && /^[0-9a-f]+$/i.test(provided)) {
    return safeEqual(Buffer.from(hex, "hex"), Buffer.from(provided, "hex"));
  }

  const standard = mac.toString("base64");
  const unpadded = standard.replace(/=+$/, "");
  const url = unpadded.replaceAll("+", "-").replaceAll("/", "_");
  return (
    safeEqualString(standard, provided) ||
    safeEqualString(unpadded, provided) ||
    safeEqualString(url, provided)
  );
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function safeEqualString(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return safeEqual(a, b);
}
