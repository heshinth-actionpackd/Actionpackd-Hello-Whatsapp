import pg from "pg";
import type { AppConfig } from "../config.js";

export interface ConnectionOptions {
  connectionString: string;
  ssl: pg.PoolConfig["ssl"];
}

/**
 * `sslmode=require` is what Railway's public Postgres URL uses. node-postgres
 * treats that mode as full verification, which fails on the proxy certificate,
 * so require is mapped to TLS without chain verification. `verify-full` stays strict.
 * The sslmode parameter is removed from the URL so pg does not apply it twice.
 */
export function connectionOptions(databaseUrl: string): ConnectionOptions {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return { connectionString: databaseUrl, ssl: undefined };
  }

  const sslmode = url.searchParams.get("sslmode");
  if (sslmode === "require") {
    url.searchParams.delete("sslmode");
    return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
  }
  if (sslmode === "verify-ca" || sslmode === "verify-full") {
    url.searchParams.delete("sslmode");
    return { connectionString: url.toString(), ssl: { rejectUnauthorized: true } };
  }
  if (sslmode === "disable") {
    url.searchParams.delete("sslmode");
    return { connectionString: url.toString(), ssl: undefined };
  }
  return { connectionString: databaseUrl, ssl: undefined };
}

export function createPool(config: AppConfig): pg.Pool {
  const options = connectionOptions(config.DATABASE_URL);
  return new pg.Pool({
    connectionString: options.connectionString,
    max: 10,
    // Fail instead of waiting forever when every connection is already in a turn.
    connectionTimeoutMillis: 10_000,
    ssl: options.ssl,
  });
}
