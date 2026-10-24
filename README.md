# Actionpackd Hello on WhatsApp

A marketing chatbot for [Actionpackd](https://hello.actionpackd.com). Someone messages the Actionpackd number on WhatsApp. This service checks the signature, remembers the chat, and asks a Mistral agent (created in Mistral Studio) for the reply. The agent can save a lead, hand the chat to the team, or start the conversation over.

Messaging goes through the [Actionpackd Messaging API](https://dev.actionpackd.com/docs). Replies inside the 24-hour window are plain text, with choices written as short numbered lines. The opening menu and the team alert are WhatsApp templates, because that API sends text and templates only. The conversation code does not import WhatsApp types, so a Telegram or web adapter can be added beside `src/channels/whatsapp/`.

## What a turn does

1. `POST /webhooks/actionpackd` checks the signature and parses the inbound message.
2. The event id is claimed in `processed_events`. A duplicate that already finished is ignored. If the database claim fails, the route returns 500 so Actionpackd can retry.
3. The route answers **200** and keeps working after the response. Mistral is too slow to hold the webhook open.
4. The turn takes a per-phone lock, calls the agent (or a local command), stores the reply, then sends it.
5. Sends use `Idempotency-Key` `{eventId}:{index}`. If a send throws, the event stays `processing` and the next delivery of that event resends the same payloads. It does not call Mistral again.

A greeting with no conversation yet (`hi`, `hello`, `hey`, `good morning`, `good afternoon`, `good evening`) sends the menu template and does not call Mistral. A reply of `1` through `5` while there is still no conversation is read as that line of the opening menu (Business Agents, Media Agents, Reminder Bot, Follow-Up Bot, Talk to the team). Any other first message starts a conversation. `start over`, `restart`, and `menu` drop the stored conversation id and send the menu again.

While `contacts.human_takeover` is true, messages from that customer are stored and not answered. The team number is not a customer chat. From that number, `BOT ON <phone>` clears the flag. Example: `BOT ON 919876543210`. Any other text from the team number gets those instructions back.

## Layout

```
src/index.ts                     migrate, listen on 0.0.0.0:$PORT, drain turns on SIGTERM
src/app.ts                       Fastify app, raw-body parser, /health, /ready
src/config.ts                    env validation
src/conversation/run-turn.ts     one inbound event, idempotent
src/conversation/agent-loop.ts   Mistral turn, tool calls, fallback text
src/conversation/tools.ts        save_lead, handoff_to_team, start_over
src/mistral/                     AgentClient plus the official SDK adapter
src/channels/whatsapp/           signature, parser, Actionpackd client, route
src/db/                          pg pool, SQL migration runner, queries
migrations/001_init.sql          contacts, leads, processed_events
agent/instructions.md            system prompt to paste into Mistral Studio
agent/tools.json                 the three function tools, same JSON as the code
```

Postgres access is `pg` plus numbered SQL files. There is no ORM. Applied files are recorded in `schema_migrations`.

## Prerequisites

- Node.js 22 LTS (the Docker image is `node:22-bookworm-slim`)
- Postgres 14 or newer (the compose file runs 16)
- An Actionpackd API key, and a Mistral API key
- A Mistral Studio agent (steps below). The server starts without a working agent, and answers with the fallback text if Mistral errors

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

## Mistral Studio

Create a **new** agent in [Mistral Studio](https://console.mistral.ai) (La Plateforme). Do not reuse an agent id from another bot.

1. Model: `mistral-medium-latest` is a reasonable default. Any function-calling chat model is fine.
2. Instructions: paste the whole of [`agent/instructions.md`](agent/instructions.md). Fill the two TODO blocks under Knowledge before you rely on prices or the safety answer. Until those still say TODO, the prompt tells the agent to hand that question to the team.
3. Tools: add three function tools. Paste [`agent/tools.json`](agent/tools.json) (the same JSON is below). If Studio has a "require confirmation" toggle for a tool, leave it off. This server executes `function.call` outputs itself and appends `function.result`. It does not send `tool_confirmations`.
4. Copy the agent id into `MISTRAL_AGENT_ID`, and a La Plateforme API key into `MISTRAL_API_KEY`.
5. Restart the server after changing env.

The server does not send the tool list on the API request. If the tools are missing on the agent, the model will not emit function calls, and leads will not be saved.

```json
[
  {
    "type": "function",
    "function": {
      "name": "save_lead",
      "description": "Save or update what this person has told you. Call this as soon as they share a name, a business type, what they need, whether they have a WhatsApp Business number, or any other useful detail. Omit fields you do not know. Do not invent values.",
      "parameters": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "description": "Their name, if they gave one." },
          "business_type": {
            "type": "string",
            "description": "What they run, in their words. Examples: B2C bakery, fleet workshop, clinic, salon, gym, real estate, distributor."
          },
          "need": {
            "type": "string",
            "description": "Which product they want, or a short description of the job. Examples: Follow-Up Bot, Reminder Bot, Business Agents, Media Agents, plans and price."
          },
          "has_whatsapp_business_number": {
            "type": "boolean",
            "description": "True when they already have a WhatsApp Business number, false when they say they do not."
          },
          "notes": {
            "type": "string",
            "description": "Anything else the team should know. Do not repeat the other fields."
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "handoff_to_team",
      "description": "Hand this chat to the Actionpackd team. Call this when they ask to talk to the team, a person, sales, or support, or when you cannot answer from the knowledge section. summary is a short brief: who they are, the business, what they want, and the details they gave. After this returns, tell them the team has it. Do not ask a follow-up question. The bot stops replying to them until the team turns it back on.",
      "parameters": {
        "type": "object",
        "properties": {
          "summary": {
            "type": "string",
            "description": "Brief for the team. One to four sentences. No phone number; the app adds that."
          }
        },
        "required": ["summary"],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "start_over",
      "description": "Forget the current conversation. Call this when they want to start again, restart, or go back to the main menu. The next message they send starts a fresh chat. Confirm briefly and offer the five opening choices as a numbered list.",
      "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    }
  }
]
```

`save_lead` upserts `leads` by the sender's phone. Omitted fields keep their previous values. `handoff_to_team` sends the team alert and sets `contacts.human_takeover`. `start_over` drops `contacts.mistral_conversation_id` after that turn's tool results have been appended. The lead row is kept.

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
| `MISTRAL_API_KEY`            | yes      | La Plateforme API key                                                       |
| `MISTRAL_AGENT_ID`           | yes      | Agent id from Studio                                                        |
| `MISTRAL_BASE_URL`           | no       | SDK origin. Defaults to `https://api.mistral.ai`. Do not append `/v1`       |
| `TEAM_WHATSAPP_NUMBER`       | yes      | Number that receives handoff alerts and can send `BOT ON`. Stored as digits |
| `PORT`                       | no       | Defaults to `3000`. Railway sets this                                       |
| `NODE_ENV`                   | no       | `development` (default), `test`, or `production`                            |
| `LOG_LEVEL`                  | no       | Pino level, default `info`                                                  |

A Railway **public** database URL should keep `sslmode=require`. The pool turns that into TLS without verifying the proxy certificate. Use `sslmode=verify-full` if you want strict verification. `sslmode=disable` turns TLS off.

`apk_test_` keys are a sandbox: Actionpackd validates the send and can call your webhook, and nothing is delivered on WhatsApp. `apk_live_` sends on the connected number.

Each Mistral request times out after 20 seconds. SDK retries are off, so a timeout or HTTP error becomes the fallback reply instead of a long retry. At most three rounds of tool results are appended for one user message.

## Scripts

```bash
npm test          # unit tests, no Postgres and no calls to Actionpackd or Mistral
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

Photos, voice notes, and other non-text messages get a short note asking for text. They are not passed to Mistral.

## Tables

`contacts.phone` is the WhatsApp sender, digits only. `mistral_conversation_id` is the id returned by the last Conversations API call. `human_takeover` stops the bot. `last_inbound_at` is updated on each customer message.

`leads` is one row per phone: `name`, `business_type`, `need`, `has_whatsapp_business_number`, `notes`.

`processed_events.deliveries` is a JSON array of `{ channel, to, reply }`. `status` moves from `processing` to `processed` only after every send has succeeded.

## Mistral API assumptions

Checked against the Agents and Conversations docs on docs.mistral.ai, the Studio function-calling guide, and `@mistralai/mistralai` 3.2.0 type definitions (24 Oct 2026). Not called with a live API key in this repo.

- Start a conversation with `client.beta.conversations.start({ agentId, inputs, store: true })`, which is `POST /v1/conversations`.
- Continue with `client.beta.conversations.append({ conversationId, conversationAppendRequest: { inputs, store: true } })`, which is `POST /v1/conversations/{conversation_id}`.
- The docs say an append returns a conversation id. This server stores whatever `conversation_id` came back, unless `start_over` cleared it.
- A function call is an output with `type: "function.call"`, `name`, `arguments` (object or JSON string), and `tool_call_id`. The result is appended as `{ type: "function.result", tool_call_id, result }` where `result` is a JSON string. That matches the Studio guide's `FunctionResultEntry`.
- Assistant text is `type: "message.output"`. Chunks with `type: "think"` are dropped. Built-in tool executions (`web_search` and similar) are ignored. If you add those on the agent, their text still has to arrive as a message for us to forward it.
- A 404 on appending a **user** message starts a new conversation once. A 404 on appending **tool results** drops the stored id and the user gets the fallback text. The SDK's `statusCode` is what we treat as 404. The live error body was not verified.
- `handoff_execution` is left at the API default (`server`). That flag is for agent-to-agent handoffs, not for `handoff_to_team`.
- Pending tool confirmation (`confirmation_status: "pending"`) is not handled. Turn confirmation off in Studio. If a live call stalls on a pending tool, that is why.
- A crash after the 200 and before the deliveries are saved will not be retried by Actionpackd, because the webhook already succeeded. A later duplicate of that event id still resumes an event left in `processing`.

## What this demo does not do

It does not download WhatsApp media, take payment, or quote a price. Pricing and the safety answer belong in the Knowledge section of `agent/instructions.md`. Adding Telegram means a new adapter and a migration that widens the `channel` check constraint. The core already talks to an `AgentClient` and a `ChannelAdapter` rather than to WhatsApp or Mistral directly.
