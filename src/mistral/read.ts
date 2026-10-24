import type { AgentOutput, AgentResponse } from "./types.js";

/**
 * Normalizes a Conversations API response. The official SDK returns camelCase
 * (`conversationId`, `toolCallId`). Snake_case is accepted too, so a raw JSON
 * body can be read the same way.
 *
 * ASSUMPTION: assistant text is `type: "message.output"` with a string content
 * or an array of chunks. Chunks with `type: "think"` are dropped. A function
 * call is `type: "function.call"` with `name`, `arguments` (object or JSON
 * string), and `tool_call_id`.
 */
export function readAgentResponse(response: unknown): AgentResponse {
  if (!isRecord(response)) throw new Error("mistral response was not an object");
  const conversationId =
    readString(response.conversationId) ?? readString(response.conversation_id);
  if (!conversationId) throw new Error("mistral response missing conversation id");

  const rawOutputs = Array.isArray(response.outputs) ? response.outputs : [];
  const outputs: AgentOutput[] = [];
  for (const output of rawOutputs) {
    const parsed = readOutput(output);
    if (parsed) outputs.push(parsed);
  }
  return { conversationId, outputs };
}

function readOutput(output: unknown): AgentOutput | null {
  if (!isRecord(output)) return null;
  if (output.type === "function.call") {
    const name = readString(output.name);
    const toolCallId = readString(output.toolCallId) ?? readString(output.tool_call_id);
    if (!name || !toolCallId) return null;
    return {
      type: "function_call",
      call: { name, toolCallId, arguments: output.arguments ?? {} },
    };
  }
  if (output.type === "message.output" || output.role === "assistant") {
    const text = readContent(output.content);
    if (!text) return null;
    return { type: "text", text };
  }
  return null;
}

function readContent(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const chunk of content) {
    if (!isRecord(chunk) || chunk.type === "think") continue;
    if (typeof chunk.text === "string" && chunk.text.trim()) parts.push(chunk.text);
  }
  const joined = parts.join("").trim();
  return joined.length > 0 ? joined : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
