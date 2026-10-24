import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const required = {
  DATABASE_URL: "postgres://localhost/hello",
  ACTIONPACKD_API_KEY: "apk_test_x",
  ACTIONPACKD_WEBHOOK_SECRET: "secret",
  MISTRAL_API_KEY: "mistral",
  MISTRAL_AGENT_ID: "ag_123",
  TEAM_WHATSAPP_NUMBER: "+91 98000 00000",
};

describe("loadConfig", () => {
  it("applies defaults and normalizes the team number", () => {
    const config = loadConfig(required);
    expect(config.PORT).toBe(3000);
    expect(config.ACTIONPACKD_BASE_URL).toBe("https://api.actionpackd.com/v1");
    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.MISTRAL_BASE_URL).toBeUndefined();
    expect(config.TEAM_WHATSAPP_NUMBER).toBe("919800000000");
  });

  it("treats a blank Mistral base URL as unset", () => {
    const config = loadConfig({ ...required, MISTRAL_BASE_URL: "  " });
    expect(config.MISTRAL_BASE_URL).toBeUndefined();
  });

  it("names the missing variables", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({})).toThrow(/ACTIONPACKD_API_KEY/);
    expect(() => loadConfig({})).toThrow(/ACTIONPACKD_WEBHOOK_SECRET/);
    expect(() => loadConfig({})).toThrow(/MISTRAL_API_KEY/);
    expect(() => loadConfig({})).toThrow(/MISTRAL_AGENT_ID/);
    expect(() => loadConfig({})).toThrow(/TEAM_WHATSAPP_NUMBER/);
  });
});
