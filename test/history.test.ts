import { describe, expect, it } from "vitest";
import {
  functionResponseBody,
  isFunctionResponseMessage,
  trimHistory,
  type HistoryMessage,
} from "../src/conversation/history.js";

function user(text: string): HistoryMessage {
  return { role: "user", parts: [{ text }] };
}

function model(text: string): HistoryMessage {
  return { role: "model", parts: [{ text }] };
}

function call(name: string): HistoryMessage {
  return { role: "model", parts: [{ functionCall: { name, id: name, args: {} } }] };
}

function result(name: string): HistoryMessage {
  return {
    role: "user",
    parts: [{ functionResponse: { name, id: name, response: { output: { ok: true } } } }],
  };
}

describe("trimHistory", () => {
  it("keeps the last N user-text turns and the tool rows inside them", () => {
    const messages = [
      user("u1"),
      model("m1"),
      user("u2"),
      call("save_lead"),
      result("save_lead"),
      model("m2"),
      user("u3"),
      model("m3"),
    ];
    const kept = trimHistory(messages, 2);
    expect(kept[0]).toEqual(user("u2"));
    expect(kept.some(isFunctionResponseMessage)).toBe(true);
    expect(isFunctionResponseMessage(kept[0]!)).toBe(false);
    expect(trimHistory(messages, 1)[0]).toEqual(user("u3"));
  });

  it("drops a leading function response left over from the row before the window", () => {
    const messages = [
      result("save_lead"),
      user("keep me"),
      model("ok"),
      call("other"),
      result("other"),
    ];
    const kept = trimHistory(messages, 20);
    expect(kept[0]).toEqual(user("keep me"));
    expect(isFunctionResponseMessage(kept[0]!)).toBe(false);
    expect(kept.some(isFunctionResponseMessage)).toBe(true);
  });

  it("drops every leading function response until a real turn starts", () => {
    const kept = trimHistory(
      [result("a"), result("b"), model("orphan call leftover"), user("hi")],
      20,
    );
    expect(kept[0]).toEqual(model("orphan call leftover"));
    expect(kept.at(-1)).toEqual(user("hi"));
  });
});

describe("functionResponseBody", () => {
  it("wraps success in output and failure in error", () => {
    expect(functionResponseBody('{"ok":true,"lead":{"name":"Priya"}}')).toEqual({
      output: { ok: true, lead: { name: "Priya" } },
    });
    expect(functionResponseBody('{"ok":false,"error":"nothing_to_save"}')).toEqual({
      error: { ok: false, error: "nothing_to_save" },
    });
    expect(functionResponseBody("not json")).toEqual({ output: { text: "not json" } });
  });
});
