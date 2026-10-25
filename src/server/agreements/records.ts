// Records the platform keeps as proof of what people agreed to. Generated once, stored in the vault, referenced by hash.
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { businesses, invoiceConfirmations, invoices } from "../db/schema";
import { putGenerated } from "../vault";
import { renderPdf } from "./pdf";
import { confirmationRecord, TEMPLATE_VERSION } from "./templates";

/** The buyer's confirmation as a PDF: the exact wording it was shown, who confirmed it, how, when and from where. */
export async function recordConfirmation(db: Database, invoiceId: string) {
  const [c] = await db.select().from(invoiceConfirmations).where(eq(invoiceConfirmations.invoiceId, invoiceId));
  if (!c || c.status !== "confirmed" || !c.acceptanceText || !c.respondedAt) throw new Error("no confirmation to record");
  if (c.recordRef) return { ref: c.recordRef, hash: c.recordHash! };
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  const [[seller], [buyer]] = await Promise.all([
    db.select({ legalName: businesses.legalName }).from(businesses).where(eq(businesses.id, inv.sellerId)),
    db.select({ legalName: businesses.legalName }).from(businesses).where(eq(businesses.id, inv.buyerId)),
  ]);
  const doc = confirmationRecord({
    seller, buyer, invoice: { invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, amount: inv.amount },
    wording: c.acceptanceText.split("\n"), version: c.acceptanceVersion ?? "", via: c.method === "link" ? "link" : "buyer",
    email: c.respondedByEmail ?? "unknown", at: c.respondedAt, ip: c.ip, userAgent: c.userAgent,
  });
  const { ref, hash } = await putGenerated(await renderPdf(doc, { footer: `Marichi Labs  confirmation record  ${TEMPLATE_VERSION}` }));
  await db.update(invoiceConfirmations).set({ recordRef: ref, recordHash: hash }).where(eq(invoiceConfirmations.id, c.id));
  return { ref, hash };
}
