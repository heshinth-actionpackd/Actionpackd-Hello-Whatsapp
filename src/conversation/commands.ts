import { openingChoices } from "./copy.js";

const RESET = new Set(["start over", "restart", "menu"]);

const GREETINGS = new Set([
  "hi",
  "hello",
  "hey",
  "hiya",
  "good morning",
  "good afternoon",
  "good evening",
]);

/** Text the agent should see. Button titles win; a payload is used when that is all we have. */
export function userText(input: { text: string | null; buttonId: string | null }): string | null {
  const text = input.text?.trim() ?? "";
  if (text) return text;
  const button = input.buttonId?.trim() ?? "";
  return button || null;
}

export function isResetCommand(text: string): boolean {
  return RESET.has(normalize(text));
}

export function isGreeting(text: string): boolean {
  return GREETINGS.has(normalize(text));
}

/**
 * A bare number answers the opening menu. Only use this when this phone has
 * no stored history yet, so a later numbered list stays the model's to read.
 */
export function openingChoice(text: string): string | null {
  const match = /^\s*(\d+)\s*[.)]?\s*$/.exec(text);
  const digit = match?.[1];
  if (!digit) return null;
  return openingChoices()[Number(digit) - 1] ?? null;
}

/**
 * `BOT ON <phone>` from the team number. Returns the customer digits, or null
 * when the message is not that command.
 */
export function parseBotOn(text: string): string | null {
  const match = /^\s*bot\s+on\s+(.+?)\s*$/i.exec(text);
  const raw = match?.[1];
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

function normalize(text: string): string {
  return text
    .trim()
    .replace(/[.!]+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
