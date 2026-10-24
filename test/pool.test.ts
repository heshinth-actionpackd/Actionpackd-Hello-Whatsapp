import { describe, expect, it } from "vitest";
import { connectionOptions } from "../src/db/pool.js";

describe("Postgres connection options", () => {
  it("turns sslmode=require into TLS that does not verify the proxy certificate", () => {
    const options = connectionOptions(
      "postgres://postgres:hello@localhost:5432/hello?sslmode=require",
    );
    expect(options.connectionString).not.toContain("sslmode");
    expect(options.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("leaves a local URL without sslmode alone", () => {
    const url = "postgres://postgres:hello@localhost:5432/hello";
    expect(connectionOptions(url)).toEqual({ connectionString: url, ssl: undefined });
  });
});
