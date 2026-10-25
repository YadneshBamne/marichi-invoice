// Load the public sanctions lists (OFAC, UN, EU) into the database now, and show how fresh each is.
// usage: npx tsx --env-file=.env scripts/refresh-sanctions.ts
import { db, pool } from "../src/server/db/client";
import { refreshSanctionLists, sanctionsStatus } from "../src/server/aml/service";

async function main() {
  for (const r of await refreshSanctionLists(db)) console.log(r.ok ? `${r.list}: ${r.entries} names loaded` : `${r.list}: FAILED ${r.error}`);
  for (const s of await sanctionsStatus(db)) console.log(`${s.list}: ${s.entries} names, loaded ${s.loadedAt?.toISOString() ?? "never"}${s.stale ? " (STALE)" : ""}`);
  await pool.end();
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
