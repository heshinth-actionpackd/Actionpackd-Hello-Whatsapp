import type { AgentOutput } from "../agent/types.js";
import { isRecord, type HistoryMessage } from "../conversation/history.js";

interface PlainPart {
  text?: string;
  thought?: true;
  thoughtSignature?: string;
  functionCall?: { name: string; id: string; args: Record<string, unknown> };
}

/**
 * Reads the first candidate's parts. Thought signatures are copied off the
 * part object (including getters) so they can be stored and sent back.
 * Thought text is kept on the stored part and left out of the user-visible outputs.
 */
export function readModelMessage(response: unknown): {
  message: HistoryMessage;
  outputs: AgentOutput[];
} {
  const parts = plainParts(candidateParts(response));
  const outputs = outputsFromParts(parts);
  if (outputs.length === 0) {
    throw new Error("gemini response had no text or function call");
  }
  return { message: { role: "model", parts }, outputs };
}

function candidateParts(response: unknown): unknown[] {
  if (!isRecord(response) || !Array.isArray(response.candidates)) return [];
  const candidate = response.candidates[0];
  if (!isRecord(candidate) || !isRecord(candidate.content)) return [];
  return Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
}

function plainParts(raw: unknown[]): PlainPart[] {
  const parts: PlainPart[] = [];
  let callIndex = 0;
  for (const rawPart of raw) {
    if (!isRecord(rawPart)) continue;
    const part: PlainPart = {};
    const text = readString(rawPart.text);
    if (text !== undefined) part.text = text;
    if (rawPart.thought === true) part.thought = true;
    const signature = readString(rawPart.thoughtSignature) ?? readString(rawPart.thought_signature);
    if (signature) part.thoughtSignature = signature;
    const call = plainFunctionCall(rawPart.functionCall, callIndex);
    if (call) {
      part.functionCall = call;
      callIndex += 1;
    }
    if (part.text !== undefined || part.thought || part.thoughtSignature || part.functionCall) {
      parts.push(part);
    }
  }
  return parts;
}

function plainFunctionCall(
  value: unknown,
  index: number,
): { name: string; id: string; args: Record<string, unknown> } | null {
  if (!isRecord(value)) return null;
  const name = readString(value.name);
  if (!name) return null;
  const id = readString(value.id) ?? `call_${index}`;
  const args = isRecord(value.args) ? cloneRecord(value.args) : {};
  return { name, id, args };
}

function outputsFromParts(parts: PlainPart[]): AgentOutput[] {
  const outputs: AgentOutput[] = [];
  for (const part of parts) {
    if (part.thought === true && !part.functionCall) continue;
    if (part.text && part.text.trim() && part.thought !== true) {
      outputs.push({ type: "text", text: part.text });
    }
    if (part.functionCall) {
      outputs.push({
        type: "function_call",
        call: {
          toolCallId: part.functionCall.id,
          name: part.functionCall.name,
          arguments: part.functionCall.args,
        },
      });
    }
  }
  return outputs;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
