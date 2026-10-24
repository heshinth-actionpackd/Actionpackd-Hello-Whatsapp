import { describe, expect, it } from "vitest";
import { readAgentResponse } from "../src/mistral/read.js";

describe("Mistral conversation response reader", () => {
  it("reads assistant text and drops think chunks", () => {
    const response = readAgentResponse({
      conversationId: "conv_1",
      outputs: [
        {
          type: "message.output",
          role: "assistant",
          content: [
            { type: "think", text: "draft" },
            { type: "text", text: "Which one do you need?" },
          ],
        },
      ],
    });
    expect(response).toEqual({
      conversationId: "conv_1",
      outputs: [{ type: "text", text: "Which one do you need?" }],
    });
  });

  it("reads a function call from snake_case or camelCase fields", () => {
    const snake = readAgentResponse({
      conversation_id: "conv_2",
      outputs: [
        {
          type: "function.call",
          name: "save_lead",
          tool_call_id: "call_1",
          arguments: '{"name":"Priya"}',
        },
      ],
    });
    expect(snake.outputs).toEqual([
      {
        type: "function_call",
        call: {
          name: "save_lead",
          toolCallId: "call_1",
          arguments: '{"name":"Priya"}',
        },
      },
    ]);

    const camel = readAgentResponse({
      conversationId: "conv_3",
      outputs: [
        {
          type: "function.call",
          name: "handoff_to_team",
          toolCallId: "call_2",
          arguments: { summary: "Bakery, follow-up bot" },
        },
      ],
    });
    expect(camel.outputs[0]).toMatchObject({
      type: "function_call",
      call: { toolCallId: "call_2", name: "handoff_to_team" },
    });
  });
});
