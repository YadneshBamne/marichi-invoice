import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// node-postgres (TCP) rather than Neon's HTTP driver:
// ledger/disbursement code needs interactive transactions.
const g = globalThis as unknown as { pool?: Pool };
// A fresh TLS connection to a remote Neon region costs 1-3 s, so connections are kept warm: two always open, idle ones
// live ten minutes (the default is ten seconds, which made the first click after a pause crawl).
export const pool = g.pool ?? new Pool({
  connectionString: process.env.DATABASE_URL, max: 10, min: 2, idleTimeoutMillis: 600_000, connectionTimeoutMillis: 15_000, keepAlive: true,
});
pool.on("error", (e) => console.error("[db] idle client error (it will be replaced):", e.message)); // never crash on a dropped idle socket
if (process.env.NODE_ENV !== "production" && !g.pool) {
  g.pool = pool;
  // Dev only: keep the Neon compute awake between clicks (it suspends after ~5 min idle and then needs seconds to wake).
  setInterval(() => { pool.query("select 1").catch(() => {}); }, 4 * 60_000).unref();
}

export const db = drizzle(pool, { schema });
/** Driver-agnostic handle: services take this so tests can pass in-memory PGlite. */
export type Database = PgDatabase<any, typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
