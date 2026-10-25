import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, invoiceCollections, invoices, strReports } from "../db/schema";
import { T0, world } from "../testkit";
import { openCase, resolveCase } from "../fraud/service";
import { buildReport, bureauFile, capitalInputs, isKind, parReport, strDrafts } from "./reports";

let w: Awaited<ReturnType<typeof world>>;
const admin = { id: "00000000-0000-0000-0000-0000000000a9", role: "admin" };
const NOW = new Date("2026-12-31T10:00:00Z");
const DAY = 86_400_000;
const dayAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);
beforeEach(async () => { w = await world(); });

/** Three financed invoices: one not yet due, one 20 days late, one 100 days late. */
async function book() {
  const a = await w.financed(), b = await w.financed(), c = await w.financed();
  await w.db.update(invoices).set({ dueDate: dayAgo(-30) }).where(eq(invoices.id, a.invoiceId));
  await w.db.update(invoices).set({ dueDate: dayAgo(20) }).where(eq(invoices.id, b.invoiceId));
  await w.db.update(invoices).set({ dueDate: dayAgo(100) }).where(eq(invoices.id, c.invoiceId));
  return { a, b, c };
}
const cell = (t: { rows: (string | number | bigint | null)[][] }, label: string, col: number) => t.rows.find((r) => r[0] === label)?.[col];

describe("portfolio at risk", () => {
  it("puts each open invoice in its lateness bucket and states the share that is late", async () => {
    await book();
    const t = await parReport(w.db, NOW);
    expect(t.note).toMatch(/^DRAFT .* Not filed with RBI/);
    expect(t.rows.slice(0, 5).map((r) => [r[0], r[1]])).toEqual([["Not yet due", 1], ["1 to 30 days", 1], ["31 to 60 days", 0], ["61 to 90 days", 0], ["Over 90 days (non-performing)", 1]]);
    expect(cell(t, "Total open book", 1)).toBe(3);
    expect(cell(t, "Portfolio at risk, over 30 days", 4)).toBeCloseTo(100 / 3, 0); // one of three equal invoices
    expect(cell(t, "Portfolio at risk, over 90 days", 4)).toBeCloseTo(100 / 3, 0);
    const shares = t.rows.slice(0, 5).reduce((a, r) => a + Number(r[4]), 0);
    expect(shares).toBeGreaterThan(99.9);
    expect(shares).toBeLessThan(100.1);
  });

  it("is empty but well-formed with nothing financed, and is for admin and compliance only", async () => {
    const t = await parReport(w.db, NOW);
    expect(cell(t, "Total open book", 1)).toBe(0);
    await expect(buildReport(w.db, { id: admin.id, role: "ops" }, "par", {}, NOW)).rejects.toThrow(/forbidden/);
    await buildReport(w.db, { id: admin.id, role: "compliance" }, "par", {}, NOW);
    expect((await w.db.select().from(auditLog).where(eq(auditLog.action, "regulatory.draft"))).length).toBe(1); // who took it is recorded
  });
});

describe("credit information file", () => {
  it("has one line per facility with the amounts, days late and status, and the borrower's identifiers", async () => {
    const { a, c } = await book();
    const t = await bureauFile(w.db, NOW);
    expect(t.rows).toHaveLength(3);
    const status = (invoiceNo: string) => t.rows.find((r) => r[0] === invoiceNo)![11];
    const by = async (id: string) => (await w.db.select().from(invoices).where(eq(invoices.id, id)))[0].invoiceNumber;
    expect(status(await by(a.invoiceId))).toBe("Standard");
    expect(status(await by(c.invoiceId))).toBe("Overdue over 90 (non-performing)");
    const late = t.rows.find((r) => r[9] === 100)!;
    expect(late.slice(1, 5)).toEqual(["Seller Co", "ABCDE1234F", "27AAAAA1111A1Z5", "Big Corp"]);
    expect(Number(late[7])).toBeGreaterThan(0); // outstanding
    expect(late[8]).toBe(late[7]); // all of it is overdue
    expect(t.head).toContain("Borrower PAN");
  });

  it("includes what closed in the last year and leaves out older closures", async () => {
    const { a, b } = await book();
    await w.db.update(invoiceCollections).set({ closedAt: new Date(NOW.getTime() - 30 * DAY) }).where(eq(invoiceCollections.invoiceId, a.invoiceId));
    await w.db.update(invoiceCollections).set({ closedAt: new Date(NOW.getTime() - 400 * DAY) }).where(eq(invoiceCollections.invoiceId, b.invoiceId));
    const t = await bureauFile(w.db, NOW);
    expect(t.rows).toHaveLength(2);
    expect(t.rows.find((r) => r[11] === "Closed")![12]).toBe(dayAgo(30));
  });
});

describe("suspicious transaction reports", () => {
  async function confirmed() {
    const { a } = await book();
    const { id } = await openCase(w.db, { entityType: "invoice", entityId: a.invoiceId, rule: "duplicate_invoice", subjectBusinessId: w.sellerId, details: { with: "INV-9" } });
    await resolveCase(w.db, { caseId: id!, staff: admin, outcome: "confirmed_fraud", note: "Same invoice financed elsewhere" }, new Date("2026-12-20T10:00:00Z"));
    return id!;
  }
  // resolveCase needs an admin row to exist only for audit actor ids; no FK on them.

  it("drafts the content from a confirmed case: who, why, how much, and where filing stands", async () => {
    const id = await confirmed();
    const t = await strDrafts(w.db, NOW, "2026-12-01", "2026-12-31");
    expect(t.note).toMatch(/^DRAFT .* Not filed with RBI.*FIU-IND/);
    expect(t.rows).toHaveLength(1);
    const r = t.rows[0];
    expect(r.slice(0, 3)).toEqual([`STR-${id.slice(0, 8).toUpperCase()}`, "2026-12-20", "draft"]);
    expect(r[5]).toBe("Seller Co");
    expect(r[6]).toBe("ABCDE1234F");
    expect(r[8]).toBe("duplicate_invoice");
    expect(r[11]).toBe("INV-1");
    expect(String(r[13])).toContain("Same invoice financed elsewhere");
  });

  it("covers only the period asked for, and a sensible period", async () => {
    await confirmed();
    expect((await strDrafts(w.db, NOW, "2025-01-01", "2025-12-31")).rows).toHaveLength(0);
    await expect(strDrafts(w.db, NOW, "2026-12-31", "2026-12-01")).rejects.toThrow(/start date on or before/);
    await expect(strDrafts(w.db, NOW, "tomorrow", "2026-12-01")).rejects.toThrow(/choose a period/);
  });

  it("shows a filed report as filed", async () => {
    const id = await confirmed();
    await w.db.update(strReports).set({ status: "filed", reference: "FIU-2026-77", filedAt: new Date("2026-12-22T10:00:00Z") }).where(eq(strReports.caseId, id));
    const [r] = (await strDrafts(w.db, NOW, "2026-12-01", "2026-12-31")).rows;
    expect([r[2], r[3], r[4]]).toEqual(["filed", "2026-12-22", "FIU-2026-77"]);
  });
});

describe("capital adequacy inputs", () => {
  it("sets the platform's own exposure against its capital and names the largest buyer", async () => {
    await book();
    const t = await capitalInputs(w.db, NOW);
    expect(Number(cell(t, "Platform capital in the ledger", 1))).toBeGreaterThan(0);
    expect(t.rows.find((r) => String(r[0]).startsWith("Open principal funded from the platform"))![2]).toBe("3 invoices");
    expect(Number(t.rows.find((r) => String(r[0]).startsWith("Open principal funded from the platform"))![1])).toBeGreaterThan(0);
    expect(t.rows.find((r) => r[0] === "Largest single-buyer exposure")![2]).toBe("Big Corp");
    expect(cell(t, "Of which more than 90 days past due", 1)).not.toBe("0.00");
  });
});

describe("the list of reports", () => {
  it("knows what it can build", () => {
    expect(["par", "bureau", "str", "capital"].every(isKind)).toBe(true);
    expect(isKind("everything")).toBe(false);
    void T0;
  });
});
