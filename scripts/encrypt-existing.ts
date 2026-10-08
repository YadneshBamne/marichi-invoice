// One-off: encrypt PAN and bank account numbers that were stored before encryption existed. Safe to re-run (skips encrypted rows).
// usage: npx tsx --env-file=.env scripts/encrypt-existing.ts        (needs DATA_ENCRYPTION_KEY in .env for real data)
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/server/db/client";
import { businessBankAccounts, businesses } from "../src/server/db/schema";

async function main() {
  if (!process.env.DATA_ENCRYPTION_KEY) console.warn("WARNING: DATA_ENCRYPTION_KEY is not set; using the development-only key. Do not run this on production data.");
  // Raw read so we only touch rows that are still plaintext. The write goes through the encrypted column type.
  const pans = (await db.execute(sql`select id, pan from businesses where pan is not null and pan not like 'enc:v1:%'`)).rows as { id: string; pan: string }[];
  for (const r of pans) await db.update(businesses).set({ pan: r.pan }).where(eq(businesses.id, r.id));
  const accts = (await db.execute(sql`select id, account_number as n from business_bank_accounts where account_number not like 'enc:v1:%'`)).rows as { id: string; n: string }[];
  for (const r of accts) await db.update(businessBankAccounts).set({ accountNumber: r.n }).where(eq(businessBankAccounts.id, r.id));
  console.log(`encrypted ${pans.length} PAN(s) and ${accts.length} bank account number(s)`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
