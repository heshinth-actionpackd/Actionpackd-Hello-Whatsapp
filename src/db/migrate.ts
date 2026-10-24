import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `src/db` and `dist/db` both sit two levels under the repo root. */
export const migrationsDir = path.join(here, "../../migrations");

export async function migrate(pool: pg.Pool, directory: string = migrationsDir): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await pool.query<{ id: string }>("SELECT id FROM schema_migrations");
  const seen = new Set(applied.rows.map((row) => row.id));
  const files = (await readdir(directory)).filter((file) => /^\d+.+\.sql$/.test(file)).sort();

  const ran: string[] = [];
  for (const file of files) {
    if (seen.has(file)) continue;
    const sql = await readFile(path.join(directory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      await client.query("COMMIT");
      ran.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return ran;
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
    const ran = await migrate(pool);
    console.log(ran.length > 0 ? `Applied ${ran.join(", ")}` : "Migrations already up to date");
  } finally {
    await pool.end();
  }
}
