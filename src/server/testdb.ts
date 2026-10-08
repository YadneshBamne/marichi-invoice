import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { onTestFinished } from "vitest";
import * as schema from "./db/schema";
import type { Database } from "./db/client";

/** Fresh in-memory Postgres with the real migrations (incl. ledger triggers). Tests only. */
export async function testDb() {
  const client = new PGlite();
  onTestFinished(() => client.close()); // each instance is a WASM heap; leaking them exhausts memory
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db as unknown as Database;
}
