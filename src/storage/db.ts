import { Pool } from "pg";
import { readFileSync } from "fs";
import { join } from "path";
import { config } from "../config";

export const db = new Pool({
  connectionString: config.databaseUrl,
});

db.on("error", (err) => {
  console.error("Unexpected database error:", err);
  process.exit(1);
});

export async function runMigrations(): Promise<void> {
  const migrationPath = join(__dirname, "migrations", "001_initial.sql");
  const sql = readFileSync(migrationPath, "utf-8");
  await db.query(sql);
  console.log("Database migrations applied.");
}
