/** Shown when Gemini errors, times out, or returns nothing we can send. */
export const FALLBACK_TEXT = [
  "Sorry, I couldn't finish that just now. Send it again in a moment, or pick one:",
  "1. Business Agents",
  "2. Media Agents",
  "3. Reminder Bot",
  "4. Follow-Up Bot",
  "5. Talk to the team",
].join("\n");

/** Plain-text menu used when the approved template send is rejected. */
export const MENU_TEXT = [
  "Hand us the jobs that keep slipping. Business Agents answer enquiries, book appointments and chase payments. Media Agents turn one photo into posters, videos and voiceovers.",
  "",
  "Pick one and I'll take it from there.",
  "1. Business Agents",
  "2. Media Agents",
  "3. Reminder Bot",
  "4. Follow-Up Bot",
  "5. Talk to the team",
].join("\n");

/** HTTP 429. One reply, no retry loop. */
export const QUOTA_TEXT =
  "We're getting a lot of messages right now. Please try again in a minute.";

export const NON_TEXT_REPLY =
  "I can read text in this chat. Tell me what you need, or send MENU to see the options.";

export const TEAM_HELP =
  "Send BOT ON and the customer's number to let the bot reply to them again. Example: BOT ON 919876543210";

export function teamResumed(phone: string): string {
  return `Bot is back on for ${phone}. Their next message continues the chat.`;
}

export function teamUnknownContact(phone: string): string {
  return `I don't have a chat with ${phone} yet.`;
}

export function teamAlertText(phone: string, summary: string): string {
  return [
    "New Actionpackd Hello handoff.",
    "",
    `Customer WhatsApp: ${phone}`,
    "",
    summary,
    "",
    `Send this to let the bot reply again: BOT ON ${phone}.`,
  ].join("\n");
}

const MAX_WHATSAPP_TEXT = 4000;

export function limitText(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_WHATSAPP_TEXT) return trimmed;
  return `${trimmed.slice(0, MAX_WHATSAPP_TEXT - 1)}…`;
}
