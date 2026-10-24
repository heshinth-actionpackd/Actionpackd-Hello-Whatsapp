import { describe, expect, it } from "vitest";
import { TEMPLATE_NAMES, teamAlertReply, templateParam } from "../src/conversation/templates.js";

describe("template parameters", () => {
  it("flattens newlines so a WhatsApp body variable stays one line", () => {
    expect(templateParam("line1\nline2\tline3", 700)).toBe("line1 line2 line3");
    const reply = teamAlertReply("919876543210", "Priya\nwants the Follow-Up Bot");
    expect(reply).toMatchObject({
      kind: "template",
      templateName: TEMPLATE_NAMES.teamAlert,
      language: "en",
    });
    if (reply.kind !== "template") throw new Error("expected a template");
    expect(reply.bodyParams?.[1]).toBe("Priya wants the Follow-Up Bot");
    expect(reply.bodyParams?.[1]).not.toMatch(/\n/);
  });
});
