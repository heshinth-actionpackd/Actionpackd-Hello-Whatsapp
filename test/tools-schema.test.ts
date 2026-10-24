import { describe, expect, it } from "vitest";
import { FUNCTION_TOOLS, functionDeclarations } from "../src/conversation/tools.js";

describe("function tools", () => {
  it("declares save_lead, handoff_to_team, and start_over for Gemini", () => {
    const names = FUNCTION_TOOLS.map((tool) => tool.function.name);
    expect(names).toEqual(["save_lead", "handoff_to_team", "start_over"]);
    const handoff = FUNCTION_TOOLS[1];
    expect(handoff?.function.parameters.required).toEqual(["summary"]);

    const declarations = functionDeclarations();
    expect(declarations.map((tool) => tool.name)).toEqual(names);
    expect(declarations[0]?.parametersJsonSchema).toEqual(FUNCTION_TOOLS[0]?.function.parameters);
    expect(declarations[2]?.parametersJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });
});
