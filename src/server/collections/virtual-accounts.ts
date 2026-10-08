import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { virtualAccounts } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";

/** The invoice's collection account, issued once. The invoice id is the idempotency key, so a retry returns the same account. */
export async function ensureVirtualAccount(db: Database, invoiceId: string, gw: Adapters = gateway) {
  const [have] = await db.select().from(virtualAccounts).where(eq(virtualAccounts.invoiceId, invoiceId));
  if (have) return have;
  const va = await gw.payments.issueVirtualAccount({ idempotencyKey: `va:${invoiceId}` });
  await db.insert(virtualAccounts).values({ invoiceId, ...va }).onConflictDoNothing();
  return (await db.select().from(virtualAccounts).where(eq(virtualAccounts.invoiceId, invoiceId)))[0];
}
