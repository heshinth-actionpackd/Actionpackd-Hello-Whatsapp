import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { DEFAULT_HISTORY_TURNS } from "../src/conversation/history.js";
import { DEFAULT_GEMINI_MODEL } from "../src/gemini/constants.js";

const required = {
  DATABASE_URL: "postgres://localhost/hello",
  ACTIONPACKD_API_KEY: "apk_test_x",
  ACTIONPACKD_WEBHOOK_SECRET: "secret",
  GEMINI_API_KEY: "gemini",
  TEAM_WHATSAPP_NUMBER: "+91 98000 00000",
};

describe("loadConfig", () => {
  it("applies defaults and normalizes the team number", () => {
    const config = loadConfig(required);
    expect(config.PORT).toBe(3000);
    expect(config.ACTIONPACKD_BASE_URL).toBe("https://api.actionpackd.com/v1");
    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.GEMINI_MODEL).toBe(DEFAULT_GEMINI_MODEL);
    expect(config.GEMINI_HISTORY_TURNS).toBe(DEFAULT_HISTORY_TURNS);
    expect(config.TEAM_WHATSAPP_NUMBER).toBe("919800000000");
  });

  it("treats a blank model and history window as the defaults", () => {
    const config = loadConfig({ ...required, GEMINI_MODEL: "  ", GEMINI_HISTORY_TURNS: "" });
    expect(config.GEMINI_MODEL).toBe(DEFAULT_GEMINI_MODEL);
    expect(config.GEMINI_HISTORY_TURNS).toBe(DEFAULT_HISTORY_TURNS);
  });

  it("accepts a history window override", () => {
    const config = loadConfig({
      ...required,
      GEMINI_MODEL: "gemini-3.5-flash",
      GEMINI_HISTORY_TURNS: "8",
    });
    expect(config.GEMINI_MODEL).toBe("gemini-3.5-flash");
    expect(config.GEMINI_HISTORY_TURNS).toBe(8);
  });

  it("names the missing variables", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({})).toThrow(/ACTIONPACKD_API_KEY/);
    expect(() => loadConfig({})).toThrow(/ACTIONPACKD_WEBHOOK_SECRET/);
    expect(() => loadConfig({})).toThrow(/GEMINI_API_KEY/);
    expect(() => loadConfig({})).toThrow(/TEAM_WHATSAPP_NUMBER/);
  });
});
