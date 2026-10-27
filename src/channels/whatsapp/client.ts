import type { Reply } from "../../domain.js";

export function actionpackdErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null && "code" in parsed) {
      const code = parsed.code;
      if (typeof code === "string") return code;
    }
  } catch {
    return null;
  }
  return null;
}

export class ActionpackdError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ActionpackdError";
  }
}

export interface ActionpackdClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Small client for POST /v1/messages.
 *
 * Documented and implemented here:
 * - Base URL https://api.actionpackd.com/v1, path /messages
 * - Authorization: Bearer apk_live_... or apk_test_...
 * - Idempotency-Key required. Same key + same body returns the original send.
 * - type "text" is only accepted inside the 24-hour window (otherwise 409 SESSION_WINDOW_CLOSED)
 * - type "template" needs an APPROVED template name. components are Meta's parameter list.
 * - 202 means queued.
 *
 * ASSUMPTION: a 200 is also treated as success. The returned message id is not stored yet.
 * Confirm anything else (extra required fields, error JSON) against a test key before going live.
 */
export class ActionpackdClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ActionpackdClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendMessage(input: { to: string; idempotencyKey: string; reply: Reply }): Promise<void> {
    const response = await this.fetchImpl(messagesUrl(this.options.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify(messageBody(input.to, input.reply)),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 202 || response.status === 200) return;

    const body = await response.text();
    throw new ActionpackdError(
      `Actionpackd send failed with HTTP ${response.status}`,
      response.status,
      body.slice(0, 500),
    );
  }
}

export function messagesUrl(baseUrl: string): string {
  const withSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("messages", withSlash).toString();
}

export function messageBody(to: string, reply: Reply): Record<string, unknown> {
  if (reply.kind === "text") {
    return { to, type: "text", text: { body: reply.body } };
  }
  const template: Record<string, unknown> = {
    name: reply.templateName,
    language: reply.language,
  };
  if (reply.bodyParams && reply.bodyParams.length > 0) {
    template.components = [
      {
        type: "body",
        parameters: reply.bodyParams.map((text) => ({ type: "text", text })),
      },
    ];
  }
  return { to, type: "template", template };
}
