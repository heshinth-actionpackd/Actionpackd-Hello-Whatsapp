# Actionpackd Hello on WhatsApp

A marketing chatbot for [Actionpackd](https://hello.actionpackd.com). Someone messages the Actionpackd number on WhatsApp. This service checks the signature, remembers the chat, and asks Google Gemini for the reply. The model can save a lead, hand the chat to the team, or start the conversation over.

Messaging goes through the [Actionpackd Messaging API](https://dev.actionpackd.com/docs). Replies inside the 24-hour window are plain text, with choices written as short numbered lines. The opening menu and the team alert are WhatsApp templates, because that API sends text and templates only. The conversation code does not import WhatsApp types, so a Telegram or web adapter can be added beside `src/channels/whatsapp/`.

## What a turn does

1. `POST /webhooks/actionpackd` checks the signature and parses the inbound message.
2. The event id is claimed in `processed_events`. A duplicate that already finished is ignored. If the database claim fails, the route returns 500 so Actionpackd can retry.
3. The route answers **200** and keeps working after the response. Gemini is too slow to hold the webhook open.
4. The turn takes a per-phone lock, calls the agent (or a local command), stores the reply, then sends it.
5. Sends use `Idempotency-Key` `{eventId}:{index}`. If a send throws, the event stays `processing` and the next delivery of that event resends the same payloads. It does not call Gemini again.

A greeting with no stored history yet (`hi`, `hello`, `hey`, `good morning`, `good afternoon`, `good evening`) sends the menu template and does not call Gemini. A reply of `1` through `5` while there is still no history is read as that line of the opening menu (Business Agents, Media Agents, Reminder Bot, Follow-Up Bot, Talk to the team). Any other first message starts a conversation. `start over`, `restart`, and `menu` delete that phone's history and send the menu again.

While `contacts.human_takeover` is true, messages from that customer are stored and not answered. The team number is not a customer chat. From that number, `BOT ON <phone>` clears the flag. Example: `BOT ON 919876543210`. Any other text from the team number gets those instructions back.

## Layout

```
src/index.ts                     migrate, listen on 0.0.0.0:$PORT, drain turns on SIGTERM
src/app.ts                       Fastify app, raw-body parser, /health, /ready
src/config.ts                    env validation
src/conversation/run-turn.ts     one inbound event, idempotent
src/conversation/agent-loop.ts   Gemini turn, tool calls, fallback text
src/conversation/tools.ts        save_lead, handoff_to_team, start_over
src/gemini/                      AgentClient adapter for @google/genai
src/channels/whatsapp/           signature, parser, Actionpackd client, route
src/db/                          pg pool, SQL migration runner, queries
migrations/001_init.sql          contacts, leads, processed_events
migrations/002_messages.sql      chat history; drops mistral_conversation_id
agent/instructions.md            system instruction, loaded at startup
```

Postgres access is `pg` plus numbered SQL files. There is no ORM. Applied files are recorded in `schema_migrations`.

## Prerequisites

- Node.js 22 LTS (the Docker image is `node:22-bookworm-slim`)
- Postgres 14 or newer (the compose file runs 16)
- An Actionpackd API key, and a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
- `agent/instructions.md` in place. The server exits on startup if that file is missing, and answers with the fallback text if Gemini errors

## Setup

```bash
cp .env.example .env
docker compose up -d
npm install
npm run dev
```

`npm run dev` applies migrations and listens on port 3000. Check it:

```bash
curl -s localhost:3000/health
curl -s localhost:3000/ready
```

`/health` is process liveness and does not touch Postgres. `/ready` runs `SELECT 1`. Point Railway's healthcheck at `/health`.

Apply migrations without starting the server with `npm run migrate`.

## Google Gemini

Replies come from the Gemini API. There is no hosted agent to configure. On startup the server reads [`agent/instructions.md`](agent/instructions.md) and sends it as `systemInstruction` on every request, along with the three function declarations in `src/conversation/tools.ts` (`save_lead`, `handoff_to_team`, `start_over`). The server runs those functions itself and sends the results back. Fill the two TODO blocks under Knowledge before you rely on prices or the safety answer. Until those still say TODO, the prompt tells the model to hand that question to the team. Restart after you edit the file.

1. Create a free API key at <https://aistudio.google.com/apikey> and put it in `GEMINI_API_KEY`.
2. Leave `GEMINI_MODEL` at the default, `gemini-3.5-flash-lite`. That is the stable model id in the [Gemini 3.5 Flash Lite docs](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) (function calling is supported). On the AI Studio free tier, Flash Lite models are 15 requests per minute, 500 requests per day, and 250,000 tokens per minute. Regular Flash models on that same free tier are 5 requests per minute and 20 requests per day.
3. Free-tier prompts and responses may be used by Google to improve its products. Do not send secrets in the chat. This project does not turn on billing.

Gemini does not store the chat. Each request replays about the last 20 user turns from the `messages` table (`GEMINI_HISTORY_TURNS`). The window is cut on a user-text turn, and a leading function response is dropped so a trimmed request does not open on an orphan tool result. `start over`, `restart`, `menu`, and the `start_over` tool delete that phone's rows. The lead row is kept.

`save_lead` upserts `leads` by the sender's phone. Omitted fields keep their previous values. `handoff_to_team` sends the team alert and sets `contacts.human_takeover`.

## Templates to approve

Submit both in the Actionpackd / Meta template flow before those steps can deliver the template itself. Language code used in the API is `en`. Match that to the language you submit. Quick replies are part of the approved template. They are not sent on the API request.

Until a template is approved, a rejected send is logged as `template send failed; sending text instead` and the same message is sent as plain text (which only works inside the 24-hour window).

### `TODO_hello_menu`

Utility or marketing, whichever Meta accepts for a menu the customer just opened. No body variables. Suggested body:

```
Hand us the jobs that keep slipping.

Business Agents answer enquiries, book appointments and chase payments. Media Agents turn one photo into posters, videos and voiceovers. Reminder Bot and Follow-Up Bot keep dates and quiet chats from slipping.

Pick one and I'll take it from there.
```

Five quick-reply buttons. Set **both** the button label and the payload to the exact string, so a tap reaches the agent as that text:

| Label            | Payload          |
| ---------------- | ---------------- |
| Business Agents  | Business Agents  |
| Media Agents     | Media Agents     |
| Reminder Bot     | Reminder Bot     |
| Follow-Up Bot    | Follow-Up Bot    |
| Talk to the team | Talk to the team |

Each label is under WhatsApp's 25-character button limit. Confirm the approval form allows five quick replies (templates allow up to 10 buttons). Plans and price, safety, and "share my requirements" are not buttons. The agent offers them in text when they fit.

Replace the name `TODO_hello_menu` in `src/conversation/templates.ts` with the approved name.

### `TODO_hello_team_alert`

Utility. Two body variables, in order: customer phone, summary. Suggested body (the variable is not the first or last character of the template):

```
New Actionpackd Hello handoff.

Customer WhatsApp: {{1}}

{{2}}

Send this to let the bot reply again: BOT ON {{1}}.
```

Sample values: `919876543210` and `Priya runs a B2C bakery and wants the Follow-Up Bot. She has a WhatsApp Business number.`

The server flattens the summary to one line and cuts it at 700 characters, because template parameters cannot contain newlines or tabs. The text fallback, used when the template send fails, is the same content with real line breaks:

```
New Actionpackd Hello handoff.

Customer WhatsApp: 919876543210

Priya runs a B2C bakery and wants the Follow-Up Bot.

Send this to let the bot reply again: BOT ON 919876543210.
```

Replace `TODO_hello_team_alert` in `src/conversation/templates.ts` once the name is approved.

## Environment

| Variable                     | Required | Purpose                                                                     |
| ---------------------------- | -------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`               | yes      | Postgres connection string                                                  |
| `ACTIONPACKD_API_KEY`        | yes      | `apk_live_...` or `apk_test_...` bearer key                                 |
| `ACTIONPACKD_WEBHOOK_SECRET` | yes      | HMAC secret from `PUT /v1/webhook`                                          |
| `ACTIONPACKD_BASE_URL`       | no       | Defaults to `https://api.actionpackd.com/v1`                                |
| `GEMINI_API_KEY`             | yes      | API key from [Google AI Studio](https://aistudio.google.com/apikey)         |
| `GEMINI_MODEL`               | no       | Defaults to `gemini-3.5-flash-lite`                                         |
| `GEMINI_HISTORY_TURNS`       | no       | User turns replayed per request. Defaults to `20`                           |
| `TEAM_WHATSAPP_NUMBER`       | yes      | Number that receives handoff alerts and can send `BOT ON`. Stored as digits |
| `PORT`                       | no       | Defaults to `3000`. Railway sets this                                       |
| `NODE_ENV`                   | no       | `development` (default), `test`, or `production`                            |
| `LOG_LEVEL`                  | no       | Pino level, default `info`                                                  |

A Railway **public** database URL should keep `sslmode=require`. The pool turns that into TLS without verifying the proxy certificate. Use `sslmode=verify-full` if you want strict verification. `sslmode=disable` turns TLS off.

`apk_test_` keys are a sandbox: Actionpackd validates the send and can call your webhook, and nothing is delivered on WhatsApp. `apk_live_` sends on the connected number.

Each Gemini request times out after 20 seconds. SDK retries are off (`retryOptions.attempts` is 1, which is the original request and no follow-up), so a timeout or HTTP error becomes the fallback reply instead of a long retry. HTTP 429 is the exception: the customer gets a short note to try again in a minute, the error is logged, and the request is not retried. At most three rounds of tool results are sent for one user message.

## Scripts

```bash
npm test          # unit tests, no Postgres and no calls to Actionpackd or Gemini
npm run lint
npm run format:check
npm run typecheck
npm run build     # tsc to dist/
npm start         # node dist/index.js
```

## Docker and Railway

The image listens on `0.0.0.0` and `PORT`, runs as the `node` user, and on `SIGTERM` waits for in-flight turns before it exits. Migrations run on startup, before the server listens.

```bash
docker build -t actionpackd-hello-whatsapp .
docker run --rm -p 3000:3000 --env-file .env actionpackd-hello-whatsapp
```

On Railway, set the env vars from the table above, and set the healthcheck path to `/health`.

## Point the Actionpackd webhook here

The route is `POST /webhooks/actionpackd`. Actionpackd only accepts an HTTPS URL, so a laptop needs a tunnel.

```bash
ngrok http 3000
```

```bash
curl -X PUT "$ACTIONPACKD_BASE_URL/webhook" \
  -H "Authorization: Bearer $ACTIONPACKD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_NGROK_HOST/webhooks/actionpackd"}'
```

The first response includes `secret` once. Put that value in `ACTIONPACKD_WEBHOOK_SECRET` and restart. `POST /v1/webhook/test` sends a sample event. Unknown event types are acknowledged with `200` after the signature checks out. A `message.inbound` event we cannot parse returns `400`.

You can simulate an inbound message locally. The HTTP response is `{ "ok": true }` as soon as the event is claimed. The WhatsApp reply is sent afterwards, so watch the server log (and the Actionpackd API, for an `apk_test_` key) rather than the curl body.

```bash
BODY='{"id":"evt_local_1","type":"message.inbound","data":{"message":{"from":"919876543210","type":"text","text":{"body":"Hi"}}}}'
TS=$(date +%s)
SIG=$(node --input-type=module -e 'import {createHmac} from "node:crypto"; const body=process.argv[1]; const ts=process.argv[2]; const secret=process.argv[3]; process.stdout.write(createHmac("sha256", secret).update(ts+"."+body).digest("hex"));' "$BODY" "$TS" "$ACTIONPACKD_WEBHOOK_SECRET")
curl -sS -X POST localhost:3000/webhooks/actionpackd \
  -H "Content-Type: application/json" \
  -H "X-Actionpackd-Timestamp: $TS" \
  -H "X-Actionpackd-Signature-V2: $SIG" \
  --data "$BODY"
```

Use a new `id` for each message. Reusing an id replays the first reply.

Signature check, from the [Actionpackd docs](https://dev.actionpackd.com/docs):

- Header `X-Actionpackd-Signature-V2` is HMAC-SHA256 of `` `${X-Actionpackd-Timestamp}.${rawBody}` ``
- `X-Actionpackd-Timestamp` is Unix seconds
- Timestamps more than 5 minutes off are rejected
- The signature is computed over the raw bytes, not re-serialized JSON

The header is expected to be hex. A `sha256=` prefix and base64 are also accepted. Confirm which encoding `POST /v1/webhook/test` actually sends if verification fails.

## Send API

`src/channels/whatsapp/client.ts` posts to `{ACTIONPACKD_BASE_URL}/messages`:

```json
{ "to": "919876543210", "type": "text", "text": { "body": "..." } }
```

```json
{
  "to": "919800000000",
  "type": "template",
  "template": {
    "name": "TODO_hello_team_alert",
    "language": "en",
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "919876543210" },
          { "type": "text", "text": "Priya wants the Follow-Up Bot" }
        ]
      }
    ]
  }
}
```

Headers are `Authorization: Bearer <key>`, `Content-Type: application/json`, and `Idempotency-Key`. Documented success is HTTP `202`. The client also treats `200` as success. A template that has no parameters omits `components`. The client does not call the live API from tests.

Text outside the 24-hour window returns `409` with `SESSION_WINDOW_CLOSED`. That attempt stays `processing` and is logged. The next inbound message is a new event. Templates can still be sent outside the window, which is why the menu and the team alert are templates.

The assumed inbound envelope is:

```json
{
  "id": "evt_123",
  "type": "message.inbound",
  "data": {
    "message": {
      "from": "919876543210",
      "id": "wamid.abc",
      "type": "text",
      "text": { "body": "Hi" }
    }
  }
}
```

A template button is read from `button.payload` / `button.text` (and from an interactive reply). The button title is what the agent sees. `type: "message.status"` is stored and not turned into a conversation turn. A Meta Cloud API `entry[].changes[].value.messages[]` wrapper is also accepted. The public docs do not publish this JSON. Compare it with one real delivery before relying on it.

Photos, voice notes, and other non-text messages get a short note asking for text. They are not passed to Gemini.

## Tables

`contacts.phone` is the WhatsApp sender, digits only. `human_takeover` stops the bot. `last_inbound_at` is updated on each customer message. Migration `002_messages.sql` drops `mistral_conversation_id` from the original contacts table.

`leads` is one row per phone: `name`, `business_type`, `need`, `has_whatsapp_business_number`, `notes`.

`messages` is the Gemini transcript for one phone: `role` (`user` or `model`), `parts` (a JSON array of text, function calls, function responses, and thought signatures), and `created_at`. The index is `(phone, created_at, id)`. `start over`, `restart`, `menu`, and the `start_over` tool delete that phone's rows.

`processed_events.deliveries` is a JSON array of `{ channel, to, reply }`. `status` moves from `processing` to `processed` only after every send has succeeded. History is written in the same transaction as those deliveries, so a retry resends without calling Gemini or appending the turn twice.

## Gemini API assumptions

Checked against the Gemini API docs (function calling, thought signatures, and the `gemini-3.5-flash-lite` model page) and `@google/genai` 2.31.0 type definitions (24 Oct 2026). Not called with a live API key in this repo.

- `new GoogleGenAI({ apiKey })`, then `ai.models.generateContent({ model, contents, config })`.
- `config.systemInstruction` is the instructions file. `config.tools` is `[{ functionDeclarations }]`, using `parametersJsonSchema` from `src/conversation/tools.ts`. Automatic function calling is disabled (`automaticFunctionCalling: { disable: true }`) so this process runs the tools. `automaticContinuation` is off.
- `config.httpOptions.timeout` is milliseconds (20_000). `retryOptions.attempts: 1` means the original request and zero retries. In SDK 2.31.0, `attempts` includes the first call (`retries: attempts - 1`). The default, when `retryOptions` is omitted, is also a single try; setting it makes that explicit because a retry policy includes HTTP 429.
- A non-OK HTTP response throws `ApiError` with `status` set to the HTTP code (SDK source `throwErrorIfNotOK`). Status 429 becomes a quota reply. The live error JSON was not verified.
- History contents use roles `user` and `model`. A function response is a user part `{ functionResponse: { name, id, response } }`. Success is sent as `{ output }` and a failed tool as `{ error }`, which is what the function-calling docs describe.
- The model part is stored as returned, including `thoughtSignature`. Gemini 3 requires that signature on the current turn's function calls. The reader copies the property even when it is a getter, which is how the SDK exposes it. A live response was not available to confirm the signature is present on `candidates[0].content.parts`.
- A crash after the 200 and before the deliveries are saved will not be retried by Actionpackd, because the webhook already succeeded. A later duplicate of that event id still resumes an event left in `processing`.

## What this demo does not do

It does not download WhatsApp media, take payment, or quote a price. Pricing and the safety answer belong in the Knowledge section of `agent/instructions.md`. Adding Telegram means a new adapter and a migration that widens the `channel` check constraint. The core already talks to an `AgentClient` and a `ChannelAdapter` rather than to WhatsApp or Gemini directly.
