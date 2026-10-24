import { Mistral } from "@mistralai/mistralai";
import { readAgentResponse } from "./read.js";
import {
  StaleConversationError,
  type AgentClient,
  type AgentRequest,
  type AgentResponse,
} from "./types.js";

/** Per-request cap. SDK retries are off so a failure becomes the fallback reply. */
export const MISTRAL_TIMEOUT_MS = 20_000;

/**
 * Mistral Conversations API via `@mistralai/mistralai`.
 *
 * Checked against docs.mistral.ai (Agents & Conversations, function calling)
 * and SDK 3.2.0 types. Not exercised against a live key in this repo.
 *
 * - Start: POST /v1/conversations with `{ agent_id, inputs, store: true }`
 *   (`client.beta.conversations.start`).
 * - Append: POST /v1/conversations/{conversation_id} with `{ inputs, store: true }`
 *   (`client.beta.conversations.append`).
 * - The id returned by each call is the id to use next. Docs say an append
 *   returns a conversation id; we always keep the latest one.
 * - A function call is appended by the app, after it runs the tool, as
 *   `{ type: "function.result", tool_call_id, result }` where result is a JSON string.
 * - A 404 on a user append starts a new conversation once. A 404 on a tool-result
 *   append throws StaleConversationError so the stored id is dropped.
 * - `tools` is not sent on the request. The Studio agent must define them.
 * - `serverURL` is the origin only (default https://api.mistral.ai). The SDK adds /v1.
 */
export function createMistralAgentClient(options: {
  apiKey: string;
  agentId: string;
  baseUrl?: string;
  timeoutMs?: number;
}): AgentClient {
  const timeoutMs = options.timeoutMs ?? MISTRAL_TIMEOUT_MS;
  const sdk = new Mistral({
    apiKey: options.apiKey,
    timeoutMs,
    retryConfig: { strategy: "none" },
    ...(options.baseUrl ? { serverURL: stripTrailingSlash(options.baseUrl) } : {}),
  });

  return {
    async respond(request: AgentRequest): Promise<AgentResponse> {
      const response = await call(sdk, options.agentId, request, timeoutMs);
      return readAgentResponse(response);
    },
  };
}

async function call(
  sdk: Mistral,
  agentId: string,
  request: AgentRequest,
  timeoutMs: number,
): Promise<unknown> {
  const requestOptions = { timeoutMs };
  try {
    if (request.kind === "user" && request.conversationId) {
      return await sdk.beta.conversations.append(
        {
          conversationId: request.conversationId,
          conversationAppendRequest: { inputs: request.text, store: true },
        },
        requestOptions,
      );
    }
    if (request.kind === "tool_results") {
      return await sdk.beta.conversations.append(
        {
          conversationId: request.conversationId,
          conversationAppendRequest: {
            store: true,
            inputs: request.results.map((result) => ({
              object: "entry" as const,
              type: "function.result" as const,
              toolCallId: result.toolCallId,
              result: result.result,
            })),
          },
        },
        requestOptions,
      );
    }
    return await sdk.beta.conversations.start(
      {
        agentId,
        inputs: request.kind === "user" ? request.text : "",
        store: true,
      },
      requestOptions,
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (request.kind === "user" && request.conversationId) {
      return sdk.beta.conversations.start(
        { agentId, inputs: request.text, store: true },
        requestOptions,
      );
    }
    throw new StaleConversationError();
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return false;
  return error.statusCode === 404;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
