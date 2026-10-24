import type { Lead } from "../domain.js";
import type { Log } from "../log.js";
import { silentLog } from "../log.js";
import {
  StaleConversationError,
  type AgentClient,
  type AgentResponse,
  type FunctionCall,
} from "../mistral/types.js";
import { FALLBACK_TEXT, limitText } from "./copy.js";
import { runTool } from "./tools.js";

/** How many function-result appends we will do for one user message. */
export const MAX_TOOL_ROUNDS = 3;

export interface AgentTurnResult {
  /** Null when the turn reset the chat or the conversation id was stale. */
  conversationId: string | null;
  text: string;
  lead: Lead | null;
  humanTakeover: boolean;
  teamSummary: string | null;
  usedFallback: boolean;
}

/**
 * Sends the user text, executes function calls, and appends their results
 * until the agent returns text or the round cap is hit.
 */
export async function runAgentTurn(input: {
  agent: AgentClient;
  conversationId: string | null;
  userText: string;
  lead: Lead;
  log?: Log;
}): Promise<AgentTurnResult> {
  const log = input.log ?? silentLog;
  let conversationId = input.conversationId;
  let lead = input.lead;
  let leadTouched = false;
  let humanTakeover = false;
  let teamSummary: string | null = null;
  let resetConversation = false;
  let heldText: string | null = null;

  let response: AgentResponse;
  try {
    response = await input.agent.respond({
      kind: "user",
      conversationId,
      text: input.userText,
    });
  } catch (error) {
    log.error({ err: error }, "mistral user turn failed");
    return finish({
      conversationId: error instanceof StaleConversationError ? null : conversationId,
      text: FALLBACK_TEXT,
      lead: null,
      humanTakeover: false,
      teamSummary: null,
      usedFallback: true,
    });
  }

  conversationId = response.conversationId;
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

    try {
      response = await input.agent.respond({
        kind: "tool_results",
        conversationId,
        results,
      });
    } catch (error) {
      log.error({ err: error, round }, "mistral tool result append failed");
      if (error instanceof StaleConversationError) resetConversation = true;
      return finish({
        conversationId: resetConversation ? null : conversationId,
        text: heldText ?? FALLBACK_TEXT,
        lead: leadTouched ? lead : null,
        humanTakeover,
        teamSummary,
        usedFallback: heldText === null,
      });
    }

    if (!resetConversation) conversationId = response.conversationId;
    const latest = textOf(response);
    if (latest) heldText = latest;
  }

  if (functionCalls(response).length > 0) {
    log.warn({ event: "tool_round_limit" }, "stopped after the tool round cap");
  }

  const text = heldText ?? FALLBACK_TEXT;
  return finish({
    conversationId: resetConversation ? null : conversationId,
    text,
    lead: leadTouched ? lead : null,
    humanTakeover,
    teamSummary,
    usedFallback: heldText === null,
  });
}

function finish(result: AgentTurnResult): AgentTurnResult {
  return { ...result, text: limitText(result.text) };
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
