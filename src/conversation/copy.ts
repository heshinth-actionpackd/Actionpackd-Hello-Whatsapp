import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repliesPath = join(dirname(fileURLToPath(import.meta.url)), "../../agent/skills/replies.md");

const sections = loadReplies(repliesPath);

/** Plain-text menu used when the approved template send is rejected. */
export const MENU_TEXT = section("menu");

const CHOICE_LINE = /^(\d+)\.\s+(.+)$/;

/** Labels from the numbered lines in `# menu`, in order. */
export function openingChoices(): string[] {
  return MENU_TEXT.split("\n").flatMap((line) => {
    const label = CHOICE_LINE.exec(line)?.[2]?.trim();
    return label ? [label] : [];
  });
}

/** Shown when Gemini errors, times out, or returns nothing we can send. */
export const FALLBACK_TEXT = [section("fallback"), numberedChoices(MENU_TEXT)]
  .filter((part) => part.length > 0)
  .join("\n");

/** HTTP 429. One reply, no retry loop. */
export const QUOTA_TEXT = section("quota");

export const NON_TEXT_REPLY = section("non_text");

export const TEAM_HELP = section("team_help");

/** Body submitted for `hello_menu`. Buttons come from `openingChoices()`. */
export const MENU_TEMPLATE_BODY = section("menu_template");

/** Body submitted for `hello_team_alert`. `{{1}}` is the phone, `{{2}}` the summary. */
export const TEAM_ALERT_TEMPLATE_BODY = section("team_alert_template");

export function teamResumed(phone: string): string {
  return fill(section("team_resumed"), { phone });
}

export function teamUnknownContact(phone: string): string {
  return fill(section("team_unknown"), { phone });
}

export function teamAlertText(phone: string, summary: string): string {
  return fill(section("team_alert"), { phone, summary });
}

const MAX_WHATSAPP_TEXT = 4000;

export function limitText(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_WHATSAPP_TEXT) return trimmed;
  return `${trimmed.slice(0, MAX_WHATSAPP_TEXT - 1)}…`;
}

function section(name: string): string {
  const value = sections[name];
  if (!value) throw new Error(`${repliesPath} is missing # ${name}`);
  return value;
}

function numberedChoices(menu: string): string {
  return menu
    .split("\n")
    .filter((line) => CHOICE_LINE.test(line))
    .join("\n");
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (match, key: string) => values[key] ?? match);
}

function loadReplies(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "read failed";
    throw new Error(`Could not read ${path}: ${detail}`, { cause: error });
  }
  const loaded: Record<string, string> = {};
  let name = "";
  let lines: string[] = [];
  const flush = () => {
    if (!name) return;
    loaded[name] = lines.join("\n").trim();
  };
  for (const line of text.split("\n")) {
    const heading = /^# ([a-z0-9_]+)\s*$/.exec(line);
    const next = heading?.[1];
    if (next) {
      flush();
      name = next;
      lines = [];
      continue;
    }
    lines.push(line);
  }
  flush();
  if (Object.keys(loaded).length === 0) throw new Error(`${path} has no sections`);
  return loaded;
}
