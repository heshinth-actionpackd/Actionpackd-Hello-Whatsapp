import type { HistoryMessage } from "../conversation/history.js";

export interface FunctionCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
}

export type AgentOutput =
  { type: "text"; text: string } | { type: "function_call"; call: FunctionCall };

export interface ToolResultInput {
  toolCallId: string;
  result: string;
}

/**
 * Gemini keeps no server-side conversation. `phone` selects the history rows
 * this process stores. `tool_results` continues the turn started by `user`.
 */
export type AgentRequest =
  | { kind: "user"; phone: string; text: string }
  | { kind: "tool_results"; phone: string; results: ToolResultInput[] };

export interface AgentResponse {
  outputs: AgentOutput[];
  /**
   * Transcript rows this call produced. The Gemini client sets these to the
   * exact parts to store, including thought signatures. When omitted, the loop
   * records a plain transcript from the request and the outputs.
   */
  messages?: HistoryMessage[];
}

/** Channel-agnostic model boundary. Tests supply a fake. The Gemini adapter is the live one. */
export interface AgentClient {
  respond(request: AgentRequest): Promise<AgentResponse>;
}

/** HTTP 429 / quota exhaustion. The caller replies once and does not retry. */
export class QuotaError extends Error {
  constructor() {
    super("gemini quota exhausted");
    this.name = "QuotaError";
  }
}
