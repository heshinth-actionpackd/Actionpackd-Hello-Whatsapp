import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STUDIO_TOOLS } from "../src/conversation/tools.js";

describe("Studio tool definitions", () => {
  it("matches agent/tools.json", () => {
    const file = JSON.parse(readFileSync(new URL("../agent/tools.json", import.meta.url), "utf8"));
    expect(file).toEqual(STUDIO_TOOLS);
  });

  it("exposes save_lead, handoff_to_team, and start_over", () => {
    const names = STUDIO_TOOLS.map((tool) => tool.function.name);
    expect(names).toEqual(["save_lead", "handoff_to_team", "start_over"]);
    const handoff = STUDIO_TOOLS[1];
    expect(handoff?.function.parameters.required).toEqual(["summary"]);
  });
});
