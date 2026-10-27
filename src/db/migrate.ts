import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `src/db` and `dist/db` both sit two levels under the repo root. */
export const migrationsDir = path.join(here, "../../drizzle");

export async function migrate(pool: pg.Pool, directory: string = migrationsDir): Promise<void> {
  await runMigrations(drizzle(pool), { migrationsFolder: directory });
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  await import("dotenv/config");
  const { loadConfig } = await import("../config.js");
  const { createPool } = await import("./pool.js");
  const config = loadConfig();
  const pool = createPool(config);
  try {
    await migrate(pool);
    console.log("Migrations applied");
  } finally {
    await pool.end();
  }
}
