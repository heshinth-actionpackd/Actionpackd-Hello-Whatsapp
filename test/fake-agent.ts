import type { AgentClient, AgentRequest, AgentResponse, FunctionCall } from "../src/agent/types.js";

export class FakeAgent implements AgentClient {
  readonly requests: AgentRequest[] = [];

  constructor(
    private readonly handler: (
      request: AgentRequest,
      call: number,
    ) => Promise<AgentResponse> | AgentResponse,
  ) {}

  async respond(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(request);
    return this.handler(request, this.requests.length);
  }
}

export function textResponse(text: string): AgentResponse {
  return { outputs: [{ type: "text", text }] };
}

export function callResponse(calls: FunctionCall[]): AgentResponse {
  return {
    outputs: calls.map((call) => ({ type: "function_call", call })),
  };
}
