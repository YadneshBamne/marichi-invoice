// Filing an assignment at the country's registry (CERSAI in India, the PACRA collateral registry in Zambia).
// What the country requires comes from the pack: a deadline after assignment (India), or filing before money moves because priority
// goes to whoever files first (Zambia). Where the pack has no registry, nothing is created and nothing blocks.
import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businesses, financingOffers, invoices, registryFilings } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { financierFor } from "../agreements/keyfacts";
import { notifyStaff } from "../notify";
import { packOf } from "../../lib/countries";

const MAX_ATTEMPTS = 5;

/** Make the filing record for an accepted offer. Idempotent. Returns null where the market has no registry. */
export async function ensureFiling(db: Database, offerId: string, now = new Date()) {
  const [row] = await db.select({ offer: financingOffers, inv: invoices, seller: businesses }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .innerJoin(businesses, eq(businesses.id, invoices.sellerId))
    .where(eq(financingOffers.id, offerId));
  if (!row) throw new Error("offer not found");
  const reg = packOf(row.seller.country).registry;
  if (!reg) return null;
  const dueBy = reg.withinDays ? new Date(now.getTime() + reg.withinDays * 86_400_000).toISOString().slice(0, 10) : null;
  await db.insert(registryFilings).values({ offerId, invoiceId: row.inv.id, registry: reg.short, dueBy }).onConflictDoNothing();
  const [f] = await db.select().from(registryFilings).where(eq(registryFilings.offerId, offerId));
  return f;
}

/** Send one pending filing. A failure is recorded and retried by the worker; it never throws to the caller. */
export async function fileAssignment(db: Database, filingId: string, gw: Adapters = gateway, now = new Date()) {
  const [f] = await db.select().from(registryFilings).where(eq(registryFilings.id, filingId));
  if (!f || f.status === "filed") return f ?? null;
  const [row] = await db.select({ offer: financingOffers, inv: invoices, seller: businesses }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .innerJoin(businesses, eq(businesses.id, invoices.sellerId))
    .where(eq(financingOffers.id, f.offerId));
  const assignee = (await financierFor(db, row.offer)).legalName;
  try {
    const r = await gw.registry.file({ idempotencyKey: f.id, registry: f.registry, assignor: row.seller.legalName, assignee, invoiceNumber: row.inv.invoiceNumber, amount: row.offer.advanceAmount });
    await db.update(registryFilings).set({ status: "filed", reference: r.reference, filedAt: now, lastError: null, attempts: f.attempts + 1 }).where(eq(registryFilings.id, f.id));
    await db.insert(auditLog).values({ action: "registry.filed", entity: "offer", entityId: f.offerId, after: { registry: f.registry, reference: r.reference } });
  } catch (e) {
    await db.update(registryFilings).set({ attempts: f.attempts + 1, lastError: (e as Error).message }).where(eq(registryFilings.id, f.id));
    if (f.attempts + 1 >= MAX_ATTEMPTS) await notifyStaff(db, ["ops"], "registry_attention", { registry: f.registry, offer: f.offerId, reason: (e as Error).message }, gw, now);
  }
  const [after] = await db.select().from(registryFilings).where(eq(registryFilings.id, f.id));
  return after;
}

/** Worker: file everything pending that has not used up its attempts. */
export async function runRegistryFilings(db: Database, gw: Adapters = gateway, now = new Date()) {
  const pending = await db.select({ id: registryFilings.id }).from(registryFilings)
    .where(and(eq(registryFilings.status, "pending"), lt(registryFilings.attempts, MAX_ATTEMPTS)));
  for (const p of pending) await fileAssignment(db, p.id, gw, now);
  return pending.length;
}

/** True when nothing stops the payout: the market has no registry, filing can wait until after, or the assignment is already filed. */
export async function registryReady(db: Database, offerId: string) {
  const [row] = await db.select({ country: businesses.country }).from(financingOffers)
    .innerJoin(invoices, eq(invoices.id, financingOffers.invoiceId))
    .innerJoin(businesses, eq(businesses.id, invoices.sellerId))
    .where(eq(financingOffers.id, offerId));
  const reg = row ? packOf(row.country).registry : null;
  if (!reg || reg.when !== "before_payout") return true;
  const [f] = await db.select({ status: registryFilings.status }).from(registryFilings).where(eq(registryFilings.offerId, offerId));
  return f?.status === "filed";
}
