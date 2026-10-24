import { ApiError, GoogleGenAI, type Content, type GenerateContentConfig } from "@google/genai";
import {
  QuotaError,
  type AgentClient,
  type AgentRequest,
  type AgentResponse,
} from "../agent/types.js";
import {
  functionResponseBody,
  historyFetchLimit,
  isRecord,
  trimHistory,
  type HistoryMessage,
} from "../conversation/history.js";
import { functionDeclarations } from "../conversation/tools.js";
import type { HelloStore } from "../store.js";
import { GEMINI_TIMEOUT_MS } from "./constants.js";
import { readModelMessage } from "./read.js";

export interface GeminiCall {
  model: string;
  contents: Content[];
  config: GenerateContentConfig;
}

export type GeminiGenerate = (request: GeminiCall) => Promise<unknown>;

/**
 * Gemini generateContent via `@google/genai` 2.31.0.
 *
 * Checked against the Gemini API docs (function calling, thought signatures,
 * models/gemini-3.5-flash-lite) and the SDK type definitions. Not called with
 * a live API key in this repo.
 *
 * - `systemInstruction` is loaded once at startup and sent on every request.
 * - `tools[0].functionDeclarations` is sent on every request, including tool follow-ups.
 * - Automatic function calling is disabled. This process runs the tools.
 * - `httpOptions.timeout` is milliseconds. `retryOptions.attempts: 1` is the
 *   initial request and zero retries (the SDK would otherwise retry 429 when
 *   a retry policy is set). A 429 becomes QuotaError. The caller replies once.
 * - Model parts are stored whole, including `thoughtSignature`, and sent back.
 *   The docs require that signature on the current turn's function calls.
 * - History is loaded from Postgres. The in-memory session only covers the
 *   tool follow-ups of the turn that is running.
 */
export function createGeminiAgentClient(options: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  store: HelloStore;
  historyTurns?: number;
  timeoutMs?: number;
  generate?: GeminiGenerate;
}): AgentClient {
  const historyTurns = options.historyTurns ?? 20;
  const timeoutMs = options.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const generate = options.generate ?? createSdkGenerate(options.apiKey, timeoutMs);
  const declarations = functionDeclarations();
  const sessions = new Map<string, HistoryMessage[]>();

  const config: GenerateContentConfig = {
    systemInstruction: options.systemInstruction,
    tools: [{ functionDeclarations: declarations }],
    automaticFunctionCalling: { disable: true },
    automaticContinuation: false,
    httpOptions: {
      timeout: timeoutMs,
      retryOptions: { attempts: 1 },
    },
  };

  async function generateContent(contents: HistoryMessage[]): Promise<AgentResponse> {
    let response: unknown;
    try {
      response = await generate({
        model: options.model,
        contents: contents.map(toContent),
        config,
      });
    } catch (error) {
      if (isQuota(error)) throw new QuotaError();
      throw error;
    }
    const model = readModelMessage(response);
    return { outputs: model.outputs, messages: [model.message] };
  }

  return {
    async respond(request: AgentRequest): Promise<AgentResponse> {
      if (request.kind === "user") {
        const stored = await options.store.transact((tx) =>
          tx.listMessages(request.phone, historyFetchLimit(historyTurns)),
        );
        const contents = [
          ...trimHistory(stored, historyTurns),
          { role: "user" as const, parts: [{ text: request.text }] },
        ];
        const response = await generateContent(contents);
        const model = response.messages?.[0];
        if (!model) throw new Error("gemini response had no model message");
        sessions.set(request.phone, [...contents, model]);
        return { outputs: response.outputs, messages: [contents[contents.length - 1]!, model] };
      }

      const session = sessions.get(request.phone);
      if (!session) throw new Error("gemini tool results arrived without a user turn");
      const toolMessage = toolResultMessage(session, request.results);
      const contents = [...session, toolMessage];
      const response = await generateContent(contents);
      const model = response.messages?.[0];
      if (!model) throw new Error("gemini response had no model message");
      sessions.set(request.phone, [...contents, model]);
      return { outputs: response.outputs, messages: [toolMessage, model] };
    },
  };
}

function createSdkGenerate(apiKey: string, timeoutMs: number): GeminiGenerate {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } },
  });
  return (request) => ai.models.generateContent(request);
}

function toContent(message: HistoryMessage): Content {
  return { role: message.role, parts: message.parts as Content["parts"] };
}

function toolResultMessage(
  session: HistoryMessage[],
  results: { toolCallId: string; result: string }[],
): HistoryMessage {
  const calls = functionCallsIn(session);
  return {
    role: "user",
    parts: results.map((result, index) => {
      const call = calls.find((item) => item.id === result.toolCallId) ?? calls[index] ?? undefined;
      return {
        functionResponse: {
          name: call?.name ?? "unknown",
          id: result.toolCallId,
          response: functionResponseBody(result.result),
        },
      };
    }),
  };
}

function functionCallsIn(session: HistoryMessage[]): { id?: string; name?: string }[] {
  const latest = [...session].reverse().find((message) => message.role === "model");
  if (!latest) return [];
  const calls: { id?: string; name?: string }[] = [];
  for (const part of latest.parts) {
    if (!isRecord(part) || !isRecord(part.functionCall)) continue;
    calls.push({
      id: typeof part.functionCall.id === "string" ? part.functionCall.id : undefined,
      name: typeof part.functionCall.name === "string" ? part.functionCall.name : undefined,
    });
  }
  return calls;
}

function isQuota(error: unknown): boolean {
  if (error instanceof QuotaError) return true;
  if (error instanceof ApiError) return error.status === 429;
  if (!isRecord(error)) return false;
  if (error.status === 429 || error.statusCode === 429 || error.code === 429) return true;
  return false;
}
