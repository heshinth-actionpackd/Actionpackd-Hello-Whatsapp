import "dotenv/config";
import {
  MENU_TEMPLATE_BODY,
  openingChoices,
  TEAM_ALERT_TEMPLATE_BODY,
} from "../src/conversation/copy.js";

/**
 * Submits the two Hello templates. Reads ACTIONPACKD_API_KEY from .env and
 * the wording from agent/skills/replies.md. `body` must be a string. A
 * top-level `buttons` array is stored as Meta QUICK_REPLY buttons. A
 * `components` array on this request is ignored.
 */
const quickReplies = openingChoices().map((text) => ({ type: "QUICK_REPLY" as const, text }));

const templates = [
  {
    name: "hello_menu",
    category: "UTILITY",
    body: MENU_TEMPLATE_BODY,
    buttons: quickReplies,
  },
  {
    name: "hello_team_alert",
    category: "UTILITY",
    body: TEAM_ALERT_TEMPLATE_BODY,
    bodyExamples: [
      "919876543210",
      "Priya runs a B2C bakery and wants the Follow-Up Bot. She has a WhatsApp Business number.",
    ],
  },
];

const key = process.env.ACTIONPACKD_API_KEY?.trim();
if (!key) {
  console.error("ACTIONPACKD_API_KEY is missing from .env");
  process.exit(1);
}
if (key.startsWith("apk_test_")) {
  console.error("Template submit needs an apk_live_ key. Test keys are rejected.");
  process.exit(1);
}

const base = (process.env.ACTIONPACKD_BASE_URL ?? "https://api.actionpackd.com/v1").replace(
  /\/$/,
  "",
);

for (const template of templates) {
  const response = await fetch(`${base}/templates`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...template, language: "en" }),
  });
  const text = await response.text();
  console.log(template.name, response.status, text);
  if (response.status === 409) continue;
  if (response.status !== 200 && response.status !== 201) process.exitCode = 1;
}
