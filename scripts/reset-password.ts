// Set a new password for an existing account (dev/admin recovery; there is no email-based reset yet).
// usage: npx tsx --env-file=.env scripts/reset-password.ts <email> <new-password>
import { and, eq } from "drizzle-orm";
import { auth } from "../src/server/auth";
import { db, pool } from "../src/server/db/client";
import { account, session, users } from "../src/server/db/schema";

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error("usage: reset-password <email> <new-password (10+ chars)>");
  process.exit(1);
}

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  if (!u) throw new Error(`no account for ${email}`);
  const hash = await (await auth.$context).password.hash(password);
  await db.update(account).set({ password: hash }).where(and(eq(account.userId, u.id), eq(account.providerId, "credential")));
  await db.delete(session).where(eq(session.userId, u.id)); // sign out everywhere
  console.log(`password updated for ${email}; existing sessions ended`);
  await pool.end();
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
