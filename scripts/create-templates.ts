import "dotenv/config";

/**
 * Submits the two Hello templates. Reads ACTIONPACKD_API_KEY from .env.
 * `body` must be a string. A top-level `buttons` array is stored as Meta
 * QUICK_REPLY buttons. A `components` array on this request is ignored.
 */
const quickReplies = [
  "Business Agents",
  "Media Agents",
  "Reminder Bot",
  "Follow-Up Bot",
  "Talk to the team",
].map((text) => ({ type: "QUICK_REPLY" as const, text }));

const templates = [
  {
    name: "hello_menu",
    category: "UTILITY",
    body: [
      "Hand us the jobs that keep slipping.",
      "",
      "Business Agents answer enquiries, book appointments and chase payments. Media Agents turn one photo into posters, videos and voiceovers. Reminder Bot and Follow-Up Bot keep dates and quiet chats from slipping.",
      "",
      "Pick one and I'll take it from there.",
    ].join("\n"),
    buttons: quickReplies,
  },
  {
    name: "hello_team_alert",
    category: "UTILITY",
    body: [
      "New Actionpackd Hello handoff.",
      "",
      "Customer WhatsApp: {{1}}",
      "",
      "{{2}}",
      "",
      "To let the bot reply again, send BOT ON {{1}} from this chat.",
    ].join("\n"),
    bodyExamples: [
      "919876543210",
      "Priya runs a B2C bakery and wants the Follow-Up Bot. She has a WhatsApp Business number.",
    ],
  },
] as const;

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
