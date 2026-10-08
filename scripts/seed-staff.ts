// Create an internal user (staff roles can't self-register).
// usage: npx tsx --env-file=.env scripts/seed-staff.ts <email> <password> <ops|compliance|admin> "<name>"
import { eq } from "drizzle-orm";
import { auth } from "../src/server/auth";
import { db, pool } from "../src/server/db/client";
import { users } from "../src/server/db/schema";

const [email, password, role, name = "Staff"] = process.argv.slice(2);
if (!email || !password || !["ops", "compliance", "admin"].includes(role)) {
  console.error("usage: seed-staff <email> <password> <ops|compliance|admin> [name]");
  process.exit(1);
}
async function main() {
  const { user } = await auth.api.signUpEmail({ body: { email, password, name } });
  await db.update(users).set({ role: role as "ops" }).where(eq(users.id, user.id));
  console.log(`created ${role}: ${email} (enrol MFA at first login)`);
  await pool.end();
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
