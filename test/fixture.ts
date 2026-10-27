import { createHmac } from "node:crypto";
import type { AppConfig } from "../src/config.js";
import type { InboundMessage } from "../src/domain.js";

export const testConfig: AppConfig = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "postgres://postgres:hello@localhost:5432/hello",
  ACTIONPACKD_API_KEY: "apk_test_unit",
  ACTIONPACKD_WEBHOOK_SECRET: "test-secret",
  ACTIONPACKD_BASE_URL: "https://api.actionpackd.com/v1",
  GEMINI_API_KEY: "test-gemini",
  GEMINI_MODEL: "gemini-3.5-flash-lite",
  GEMINI_HISTORY_TURNS: 20,
  TEAM_WHATSAPP_NUMBER: "919800000000",
  LOG_LEVEL: "silent",
};

/** Spec formula: HMAC-SHA256 of `${timestamp}.${rawBody}`. */
export function signBody(secret: string, rawBody: Buffer, timestampSeconds: number): string {
  const payload = Buffer.concat([Buffer.from(String(timestampSeconds)), Buffer.from("."), rawBody]);
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function inbound(
  partial: Partial<InboundMessage> & Pick<InboundMessage, "eventId">,
): InboundMessage {
  return {
    channel: "whatsapp",
    channelUserId: "919876543210",
    phone: "919876543210",
    text: null,
    buttonId: null,
    ...partial,
  };
}
