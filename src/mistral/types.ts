export interface FunctionCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
}

export type AgentOutput =
  { type: "text"; text: string } | { type: "function_call"; call: FunctionCall };

export interface ToolResultInput {
  toolCallId: string;
  result: string;
}

export type AgentRequest =
  | { kind: "user"; conversationId: string | null; text: string }
  | { kind: "tool_results"; conversationId: string; results: ToolResultInput[] };

export interface AgentResponse {
  conversationId: string;
  outputs: AgentOutput[];
}

/** Channel-agnostic Mistral boundary. Tests supply a fake. The SDK adapter is the live one. */
export interface AgentClient {
  respond(request: AgentRequest): Promise<AgentResponse>;
}

/** Append targeted a conversation id Mistral no longer has. The turn should forget that id. */
export class StaleConversationError extends Error {
  constructor() {
    super("mistral conversation not found");
    this.name = "StaleConversationError";
  }
}
