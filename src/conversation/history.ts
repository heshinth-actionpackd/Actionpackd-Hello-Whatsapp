/** One stored Gemini content message. `parts` is the JSON array sent back on the next request. */
export interface HistoryMessage {
  role: "user" | "model";
  parts: unknown[];
}

/** How many user-text turns to replay. A turn runs from one user text through the next. */
export const DEFAULT_HISTORY_TURNS = 20;

/**
 * Rows loaded before the turn window is applied. One turn is a user text plus
 * the model and function-response rows that follow it (up to three tool rounds).
 */
export function historyFetchLimit(turns: number): number {
  return Math.max(1, turns) * 8;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFunctionResponseMessage(message: HistoryMessage): boolean {
  return message.parts.some((part) => isRecord(part) && "functionResponse" in part);
}

/** A user message that starts a turn. Function responses are also role `user`, and are not turns. */
export function isUserTextMessage(message: HistoryMessage): boolean {
  if (message.role !== "user" || isFunctionResponseMessage(message)) return false;
  return message.parts.some(
    (part) => isRecord(part) && typeof part.text === "string" && part.text.trim() !== "",
  );
}

/**
 * Keeps the last `maxTurns` user-text turns, then drops a leading function
 * response so the request never opens on an orphan tool result.
 */
export function trimHistory(messages: HistoryMessage[], maxTurns: number): HistoryMessage[] {
  if (maxTurns < 1 || messages.length === 0) return [];
  const turnStarts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message && isUserTextMessage(message)) turnStarts.push(index);
  }
  const start = turnStarts.length > maxTurns ? (turnStarts[turnStarts.length - maxTurns] ?? 0) : 0;
  return dropLeadingFunctionResponses(messages.slice(start));
}

export function userTextMessage(text: string): HistoryMessage {
  return { role: "user", parts: [{ text }] };
}

export function modelTextMessage(text: string): HistoryMessage {
  return { role: "model", parts: [{ text }] };
}

/** User text plus the reply we actually sent, with no dangling function call. */
export function exchange(userText: string, modelText: string): HistoryMessage[] {
  return [userTextMessage(userText), modelTextMessage(modelText)];
}

/**
 * Gemini wants a JSON object. `output` is a successful tool result.
 * `error` is a failed one. The docs treat any other object as the output.
 */
export function functionResponseBody(result: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result) as unknown;
  } catch {
    return { output: { text: result } };
  }
  if (!isRecord(parsed)) return { output: { value: parsed ?? null } };
  if (parsed.ok === false) return { error: parsed };
  return { output: parsed };
}

function dropLeadingFunctionResponses(messages: HistoryMessage[]): HistoryMessage[] {
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message || !isFunctionResponseMessage(message)) break;
    index += 1;
  }
  return messages.slice(index);
}
