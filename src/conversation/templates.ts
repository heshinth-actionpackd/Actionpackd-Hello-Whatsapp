import type { Reply } from "../domain.js";
import { MENU_TEXT, teamAlertText } from "./copy.js";

/**
 * Template names submitted by `scripts/create-templates.ts`. A rejected send
 * falls back to plain text, and the event stays retryable if that text send
 * also fails.
 *
 * Quick replies are stored on `hello_menu`. A tap arrives as that label.
 * `hello_team_alert` has two body variables, in order: customer phone, summary.
 */
export const TEMPLATE_NAMES = {
  menu: "hello_menu",
  teamAlert: "hello_team_alert",
} as const;

const TEMPLATE_LANGUAGE = "en";
const SUMMARY_PARAM_MAX = 700;

export function menuReply(): Reply {
  return { kind: "template", templateName: TEMPLATE_NAMES.menu, language: TEMPLATE_LANGUAGE };
}

export function teamAlertReply(phone: string, summary: string): Reply {
  return {
    kind: "template",
    templateName: TEMPLATE_NAMES.teamAlert,
    language: TEMPLATE_LANGUAGE,
    bodyParams: [templateParam(phone, 32), templateParam(summary, SUMMARY_PARAM_MAX)],
  };
}

/** WhatsApp template parameters reject newlines, tabs, and empty strings. */
export function templateParam(value: string, max: number): string {
  const flat = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  const safe = flat.length > 0 ? flat : "none";
  if (safe.length <= max) return safe;
  return `${safe.slice(0, max - 1)}…`;
}

export function textFallbackForTemplate(reply: Reply): Reply | null {
  if (reply.kind !== "template") return null;
  if (reply.templateName === TEMPLATE_NAMES.menu) {
    return { kind: "text", body: MENU_TEXT };
  }
  if (reply.templateName === TEMPLATE_NAMES.teamAlert) {
    const phone = reply.bodyParams?.[0] ?? "unknown";
    const summary = reply.bodyParams?.[1] ?? "none";
    return { kind: "text", body: teamAlertText(phone, summary) };
  }
  return null;
}
