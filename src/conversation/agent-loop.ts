import {
  QuotaError,
  type AgentClient,
  type AgentOutput,
  type AgentRequest,
  type AgentResponse,
  type FunctionCall,
  type ToolResultInput,
} from "../agent/types.js";
import type { Lead } from "../domain.js";
import type { Log } from "../log.js";
import { silentLog } from "../log.js";
import { FALLBACK_TEXT, QUOTA_TEXT, limitText } from "./copy.js";
import { exchange, functionResponseBody, type HistoryMessage } from "./history.js";
import { runTool } from "./tools.js";

/** How many function-result follow-ups we will do for one user message. */
export const MAX_TOOL_ROUNDS = 3;

export interface AgentTurnResult {
  text: string;
  lead: Lead | null;
  humanTakeover: boolean;
  teamSummary: string | null;
  resetConversation: boolean;
  usedFallback: boolean;
  /** Rows to append. Empty when this turn cleared history instead. */
  messages: HistoryMessage[];
}

/**
 * Sends the user text, executes function calls, and sends their results
 * until the model returns text or the round cap is hit.
 */
export async function runAgentTurn(input: {
  agent: AgentClient;
  phone: string;
  userText: string;
  lead: Lead;
  log?: Log;
}): Promise<AgentTurnResult> {
  const log = input.log ?? silentLog;
  let lead = input.lead;
  let leadTouched = false;
  let humanTakeover = false;
  let teamSummary: string | null = null;
  let resetConversation = false;
  let heldText: string | null = null;
  const synthesized: HistoryMessage[] = [];
  let verbatim: HistoryMessage[] | null = [];

  let response: AgentResponse;
  try {
    response = await input.agent.respond({
      kind: "user",
      phone: input.phone,
      text: input.userText,
    });
  } catch (error) {
    return failedTurn(input.userText, error, log, "gemini user turn failed");
  }

  absorb(
    synthesized,
    verbatim,
    { kind: "user", phone: input.phone, text: input.userText },
    response,
    [],
  );
  if (!response.messages?.length) verbatim = null;
  heldText = textOf(response) ?? heldText;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = functionCalls(response);
    if (calls.length === 0) break;

    const results = calls.map((call) => {
      const outcome = runTool(call.name, call.arguments, lead);
      if (outcome.lead) {
        lead = outcome.lead;
        leadTouched = true;
      }
      if (outcome.humanTakeover) humanTakeover = true;
      if (outcome.teamSummary) teamSummary = outcome.teamSummary;
      if (outcome.resetConversation) resetConversation = true;
      log.info({ tool: call.name, ok: outcome.result.ok === true }, "executed tool");
      return { toolCallId: call.toolCallId, result: JSON.stringify(outcome.result) };
    });

    const request: AgentRequest = { kind: "tool_results", phone: input.phone, results };
    try {
      response = await input.agent.respond(request);
    } catch (error) {
      const failed = failedTurn(input.userText, error, log, "gemini tool result failed", round);
      return {
        ...failed,
        lead: leadTouched ? lead : null,
        humanTakeover,
        teamSummary,
        resetConversation,
      };
    }

    absorb(synthesized, verbatim, request, response, calls);
    if (!response.messages?.length) verbatim = null;
    const latest = textOf(response);
    if (latest) heldText = latest;
  }

  if (functionCalls(response).length > 0) {
    log.warn({ event: "tool_round_limit" }, "stopped after the tool round cap");
    const text = heldText ?? FALLBACK_TEXT;
    return finish({
      text,
      lead: leadTouched ? lead : null,
      humanTakeover,
      teamSummary,
      resetConversation,
      usedFallback: heldText === null,
      messages: exchange(input.userText, text),
    });
  }

  const text = heldText ?? FALLBACK_TEXT;
  return finish({
    text,
    lead: leadTouched ? lead : null,
    humanTakeover,
    teamSummary,
    resetConversation,
    usedFallback: heldText === null,
    messages: heldText ? (verbatim ?? synthesized) : exchange(input.userText, text),
  });
}

function failedTurn(
  userText: string,
  error: unknown,
  log: Log,
  message: string,
  round?: number,
): AgentTurnResult {
  if (error instanceof QuotaError) {
    log.error({ err: error, round }, "gemini quota exhausted");
    return finish({
      text: QUOTA_TEXT,
      lead: null,
      humanTakeover: false,
      teamSummary: null,
      resetConversation: false,
      usedFallback: false,
      messages: exchange(userText, QUOTA_TEXT),
    });
  }
  log.error({ err: error, round }, message);
  return finish({
    text: FALLBACK_TEXT,
    lead: null,
    humanTakeover: false,
    teamSummary: null,
    resetConversation: false,
    usedFallback: true,
    messages: exchange(userText, FALLBACK_TEXT),
  });
}

function finish(result: AgentTurnResult): AgentTurnResult {
  return { ...result, text: limitText(result.text) };
}

function absorb(
  synthesized: HistoryMessage[],
  verbatim: HistoryMessage[] | null,
  request: AgentRequest,
  response: AgentResponse,
  calls: FunctionCall[],
): void {
  if (request.kind === "user") {
    synthesized.push({ role: "user", parts: [{ text: request.text }] });
  } else {
    synthesized.push(toolResultMessage(calls, request.results));
  }
  synthesized.push(modelOutputsMessage(response.outputs));
  if (verbatim && response.messages) verbatim.push(...response.messages);
}

function toolResultMessage(calls: FunctionCall[], results: ToolResultInput[]): HistoryMessage {
  return {
    role: "user",
    parts: results.map((result) => {
      const call = calls.find((item) => item.toolCallId === result.toolCallId);
      return {
        functionResponse: {
          name: call?.name ?? "unknown",
          id: result.toolCallId,
          response: functionResponseBody(result.result),
        },
      };
    }),
  };
}

function modelOutputsMessage(outputs: AgentOutput[]): HistoryMessage {
  return {
    role: "model",
    parts: outputs.map((output) => {
      if (output.type === "text") return { text: output.text };
      return {
        functionCall: {
          name: output.call.name,
          id: output.call.toolCallId,
          args: isArgs(output.call.arguments) ? output.call.arguments : {},
        },
      };
    }),
  };
}

function isArgs(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function functionCalls(response: AgentResponse): FunctionCall[] {
  const calls: FunctionCall[] = [];
  for (const output of response.outputs) {
    if (output.type === "function_call") calls.push(output.call);
  }
  return calls;
}

function textOf(response: AgentResponse): string | null {
  const parts: string[] = [];
  for (const output of response.outputs) {
    if (output.type === "text" && output.text.trim()) parts.push(output.text.trim());
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}
