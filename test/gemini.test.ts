import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { QuotaError } from "../src/agent/types.js";
import { loadSystemInstruction } from "../src/gemini/instructions.js";
import { createGeminiAgentClient, type GeminiCall } from "../src/gemini/client.js";
import { GEMINI_TIMEOUT_MS } from "../src/gemini/constants.js";
import { readModelMessage } from "../src/gemini/read.js";
import { functionDeclarations } from "../src/conversation/tools.js";
import { MemoryStore } from "./memory-store.js";

const PHONE = "919876543210";

function client(
  store: MemoryStore,
  generate: (request: GeminiCall) => Promise<unknown>,
  turns = 20,
) {
  return createGeminiAgentClient({
    apiKey: "test-key",
    model: "gemini-3.5-flash-lite",
    systemInstruction: "Be brief.",
    store,
    historyTurns: turns,
    generate,
  });
}

describe("Gemini response reader", () => {
  it("reads text and a function call, and copies a thought signature off a getter", () => {
    const part = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(part, "thoughtSignature", { get: () => "sig_1" });
    Object.defineProperty(part, "functionCall", {
      get: () => ({ name: "save_lead", id: "fc_1", args: { name: "Priya" } }),
    });
    const thought = { thought: true, text: "draft", thoughtSignature: "sig_thought" };
    const read = readModelMessage({
      candidates: [{ content: { role: "model", parts: [thought, part, { text: "Noted." }] } }],
    });
    expect(read.outputs).toEqual([
      {
        type: "function_call",
        call: { toolCallId: "fc_1", name: "save_lead", arguments: { name: "Priya" } },
      },
      { type: "text", text: "Noted." },
    ]);
    expect(read.message.parts[0]).toMatchObject({ thought: true, thoughtSignature: "sig_thought" });
    expect(read.message.parts[1]).toMatchObject({
      thoughtSignature: "sig_1",
      functionCall: { id: "fc_1", name: "save_lead" },
    });
    expect(JSON.stringify(read.outputs)).not.toContain("draft");
  });

  it("assigns an id when the function call did not include one", () => {
    const read = readModelMessage({
      candidates: [{ content: { parts: [{ functionCall: { name: "start_over", args: {} } }] } }],
    });
    expect(read.outputs[0]).toMatchObject({
      type: "function_call",
      call: { toolCallId: "call_0", name: "start_over" },
    });
  });
});

describe("Gemini client", () => {
  it("sends the system instruction, the three tools, and no retry policy that would loop", async () => {
    const calls: GeminiCall[] = [];
    const store = new MemoryStore();
    const agent = client(store, async (request) => {
      calls.push(request);
      return { candidates: [{ content: { parts: [{ text: "Which one?" }] } }] };
    });
    const response = await agent.respond({ kind: "user", phone: PHONE, text: "Media Agents" });
    expect(response.outputs).toEqual([{ type: "text", text: "Which one?" }]);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.model).toBe("gemini-3.5-flash-lite");
    expect(call?.config.systemInstruction).toBe("Be brief.");
    expect(call?.config.automaticFunctionCalling).toEqual({ disable: true });
    expect(call?.config.automaticContinuation).toBe(false);
    expect(call?.config.httpOptions).toMatchObject({
      timeout: GEMINI_TIMEOUT_MS,
      retryOptions: { attempts: 1 },
    });
    expect(call?.config.tools?.[0]).toMatchObject({
      functionDeclarations: functionDeclarations(),
    });
    expect(call?.contents).toEqual([{ role: "user", parts: [{ text: "Media Agents" }] }]);
  });

  it("replays a stored thought signature and does not open on a function response", async () => {
    const store = new MemoryStore();
    await store.appendMessages(PHONE, [
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "save_lead",
              id: "old",
              response: { output: { ok: true } },
            },
          },
        ],
      },
      { role: "user", parts: [{ text: "first" }] },
      { role: "model", parts: [{ text: "one" }] },
      { role: "user", parts: [{ text: "second" }] },
      {
        role: "model",
        parts: [
          {
            thoughtSignature: "sig_keep",
            functionCall: { name: "save_lead", id: "fc_keep", args: { name: "Priya" } },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "save_lead",
              id: "fc_keep",
              response: { output: { ok: true } },
            },
          },
        ],
      },
      { role: "model", parts: [{ text: "saved", thoughtSignature: "sig_text" }] },
    ]);
    const calls: GeminiCall[] = [];
    const agent = client(
      store,
      async (request) => {
        calls.push(request);
        return { candidates: [{ content: { parts: [{ text: "next" }] } }] };
      },
      1,
    );
    await agent.respond({ kind: "user", phone: PHONE, text: "third" });
    const contents = calls[0]?.contents ?? [];
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "second" }] });
    expect(JSON.stringify(contents[0])).not.toContain("functionResponse");
    expect(JSON.stringify(contents)).toContain("sig_keep");
    expect(contents.at(-1)).toEqual({ role: "user", parts: [{ text: "third" }] });
  });

  it("runs one function round trip and sends the result back with the same id", async () => {
    const calls: GeminiCall[] = [];
    const store = new MemoryStore();
    const agent = client(store, async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    thoughtSignature: "sig_fc",
                    functionCall: { name: "save_lead", id: "fc_1", args: { name: "Priya" } },
                  },
                ],
              },
            },
          ],
        };
      }
      return { candidates: [{ content: { parts: [{ text: "Got it." }] } }] };
    });
    const first = await agent.respond({ kind: "user", phone: PHONE, text: "I'm Priya" });
    expect(first.outputs[0]).toMatchObject({
      type: "function_call",
      call: { toolCallId: "fc_1", name: "save_lead" },
    });
    const second = await agent.respond({
      kind: "tool_results",
      phone: PHONE,
      results: [{ toolCallId: "fc_1", result: JSON.stringify({ ok: true, name: "Priya" }) }],
    });
    expect(second.outputs).toEqual([{ type: "text", text: "Got it." }]);
    expect(calls[1]?.contents[1]).toMatchObject({
      role: "model",
      parts: [{ thoughtSignature: "sig_fc", functionCall: { id: "fc_1" } }],
    });
    expect(calls[1]?.contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "save_lead",
            id: "fc_1",
            response: { output: { ok: true, name: "Priya" } },
          },
        },
      ],
    });
    expect(calls[1]?.config.tools?.[0]).toMatchObject({
      functionDeclarations: functionDeclarations(),
    });
    expect(second.messages?.[0]?.role).toBe("user");
    expect(second.messages?.[1]).toMatchObject({ role: "model" });
  });

  it("turns HTTP 429 into QuotaError and does not call the model again", async () => {
    let calls = 0;
    const store = new MemoryStore();
    const agent = client(store, async () => {
      calls += 1;
      throw new ApiError({ message: "RESOURCE_EXHAUSTED", status: 429 });
    });
    await expect(agent.respond({ kind: "user", phone: PHONE, text: "hi" })).rejects.toBeInstanceOf(
      QuotaError,
    );
    expect(calls).toBe(1);

    const again = client(store, async () => {
      calls += 1;
      const error = new Error("quota") as Error & { statusCode: number };
      error.statusCode = 429;
      throw error;
    });
    await expect(again.respond({ kind: "user", phone: PHONE, text: "hi" })).rejects.toBeInstanceOf(
      QuotaError,
    );
    expect(calls).toBe(2);
  });

  it("leaves other errors for the fallback path", async () => {
    const store = new MemoryStore();
    const agent = client(store, async () => {
      throw new ApiError({ message: "nope", status: 500 });
    });
    await expect(agent.respond({ kind: "user", phone: PHONE, text: "hi" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe("system instruction", () => {
  it("loads agent/instructions.md", () => {
    const text = loadSystemInstruction();
    expect(text).toContain("Actionpackd Hello");
    expect(text).toContain("save_lead");
  });
});
