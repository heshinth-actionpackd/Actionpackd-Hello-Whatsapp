import type {
  AgentClient,
  AgentRequest,
  AgentResponse,
  FunctionCall,
} from "../src/mistral/types.js";

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

export function textResponse(conversationId: string, text: string): AgentResponse {
  return { conversationId, outputs: [{ type: "text", text }] };
}

export function callResponse(conversationId: string, calls: FunctionCall[]): AgentResponse {
  return {
    conversationId,
    outputs: calls.map((call) => ({ type: "function_call", call })),
  };
}
