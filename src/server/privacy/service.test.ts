import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { account, auditLog, memberships, notifications, privacyRequests, session, users, verification } from "../db/schema";
import { gw, T0, world } from "../testkit";
import { accessExport, eraseAccount, erasureBlockers, openRequest, PRIVACY, queue, resolveRequest, runRetention } from "./service";

let w: Awaited<ReturnType<typeof world>>;
const admin = { id: "00000000-0000-0000-0000-0000000000a9", role: "admin" };
const DAY = 86_400_000;
beforeEach(async () => {
  w = await world();
  await w.db.insert(users).values({ id: admin.id, name: "Admin", email: "admin@marichi.test", role: "admin" });
  await w.db.insert(users).values({ name: "Second Admin", email: "admin2@marichi.test", role: "admin" });
});
const me = () => ({ id: w.sellerActor.id, role: "seller" });
const mails = async (template: string) => (await w.db.select().from(notifications)).filter((n) => n.template === template);

describe("a copy of my data", () => {
  it("is ready at once, holds my own data, and leaves out secrets", async () => {
    await w.db.insert(session).values({ expiresAt: new Date(T0.getTime() + DAY), token: "secret-session-token", userId: me().id, ipAddress: "203.0.113.7", userAgent: "TestBrowser" });
    await w.db.insert(account).values({ accountId: me().id, providerId: "credential", userId: me().id, password: "hashed-password-value" });
    const r = await openRequest(w.db, me(), { kind: "access" }, gw, T0);
    expect(r).toMatchObject({ status: "completed", kind: "access" });
    const data = JSON.stringify(r.exportData);
    expect(data).toContain("s@seller.com");
    expect(data).toContain("Seller Co"); // the company they belong to
    expect(data).toContain("203.0.113.7");
    expect(data).not.toContain("secret-session-token");
    expect(data).not.toContain("hashed-password-value");
    expect((await mails("privacy_request_done")).length).toBe(1);
  });

  it("does not include another person's data", async () => {
    const data = JSON.stringify(await accessExport(w.db, me().id, T0));
    expect(data).not.toContain("ap@big.com");
  });
});

describe("making a request", () => {
  it("needs a known kind, and details where staff must act on them", async () => {
    await expect(openRequest(w.db, me(), { kind: "sell-my-data" }, gw, T0)).rejects.toThrow(/choose what/);
    await expect(openRequest(w.db, me(), { kind: "correction", details: "fix" }, gw, T0)).rejects.toThrow(/what is wrong/);
    await expect(openRequest(w.db, me(), { kind: "objection" }, gw, T0)).rejects.toThrow(/which uses/);
    await expect(openRequest(w.db, me(), { kind: "erasure", details: "x".repeat(2001) }, gw, T0)).rejects.toThrow(/under 2,000/);
  });

  it("gets a due date, tells the person and the staff, and cannot be duplicated while open", async () => {
    const r = await openRequest(w.db, me(), { kind: "erasure", details: "I no longer use this" }, gw, T0);
    expect(r.status).toBe("received");
    expect(r.dueAt.getTime()).toBe(T0.getTime() + PRIVACY.responseDays * DAY);
    expect((await mails("privacy_request_received")).length).toBe(1);
    expect((await mails("privacy_request_new")).length).toBe(2); // one for each of the two admins
    await expect(openRequest(w.db, me(), { kind: "erasure" }, gw, T0)).rejects.toThrow(/already have an open/);
  });
});

describe("staff answering", () => {
  it("only admin or compliance, with a note, once, and never an access request", async () => {
    const r = await openRequest(w.db, me(), { kind: "correction", details: "My name is spelt wrongly" }, gw, T0);
    await expect(resolveRequest(w.db, { id: admin.id, role: "ops" }, r.id, { outcome: "completed", note: "fixed" }, gw, T0)).rejects.toThrow(/forbidden/);
    await expect(resolveRequest(w.db, admin, r.id, { outcome: "completed", note: "  " }, gw, T0)).rejects.toThrow(/say what/);
    await resolveRequest(w.db, admin, r.id, { outcome: "completed", note: "Name corrected" }, gw, T0);
    const [done] = await w.db.select().from(privacyRequests).where(eq(privacyRequests.id, r.id));
    expect(done).toMatchObject({ status: "completed", resolution: "Name corrected", handledBy: admin.id });
    expect((await mails("privacy_request_done")).some((n) => n.body?.includes("Name corrected"))).toBe(true);
    await expect(resolveRequest(w.db, admin, r.id, { outcome: "refused", note: "again" }, gw, T0)).rejects.toThrow(/already answered/);
  });

  it("flags a request that has passed its due date", async () => {
    await openRequest(w.db, me(), { kind: "objection", details: "No marketing messages please" }, gw, T0);
    expect((await queue(w.db, T0))[0].overdue).toBe(false);
    expect((await queue(w.db, new Date(T0.getTime() + 31 * DAY)))[0].overdue).toBe(true);
  });

  it("a deletion request is completed by erasing, not by a note", async () => {
    const r = await openRequest(w.db, me(), { kind: "erasure" }, gw, T0);
    await expect(resolveRequest(w.db, admin, r.id, { outcome: "completed", note: "done" }, gw, T0)).rejects.toThrow(/Erase account/);
    await resolveRequest(w.db, admin, r.id, { outcome: "refused", note: "Open obligations" }, gw, T0); // refusing is fine
  });
});

describe("erasing an account", () => {
  it("removes the person's details and access, keeps the records the law requires, and writes no personal data to the audit log", async () => {
    await w.db.insert(session).values({ expiresAt: new Date(T0.getTime() + DAY), token: "t1", userId: me().id });
    const r = await openRequest(w.db, me(), { kind: "erasure" }, gw, T0);
    await eraseAccount(w.db, admin, r.id, gw, T0);
    const [u] = await w.db.select().from(users).where(eq(users.id, me().id));
    expect(u).toMatchObject({ name: "Former user", phone: null, phoneVerified: false, twoFactorEnabled: false });
    expect(u.email).toBe(`erased-${me().id}@erased.invalid`);
    expect(u.suspendedAt).toBeTruthy();
    expect(await w.db.select().from(session).where(eq(session.userId, me().id))).toHaveLength(0);
    expect(await w.db.select().from(memberships).where(eq(memberships.userId, me().id))).toHaveLength(0);
    const [done] = await w.db.select().from(privacyRequests).where(eq(privacyRequests.id, r.id));
    expect(done.status).toBe("completed");
    expect(done.resolution).toMatch(/years after the relationship ends/);
    // the last notice went to the old address; nothing else of theirs is left in the message log
    const left = (await w.db.select().from(notifications)).filter((n) => n.userId === me().id);
    expect(left.map((n) => n.template)).toEqual(["privacy_request_done"]);
    expect(left[0].toAddress).toBe("s@seller.com");
    const audit = JSON.stringify(await w.db.select().from(auditLog).where(eq(auditLog.action, "privacy.erase")));
    expect(audit).not.toContain("s@seller.com");
    expect(audit).not.toContain("Seller");
    await expect(eraseAccount(w.db, admin, r.id, gw, T0)).rejects.toThrow(/not an open deletion/);
  });

  it("is refused while a company this person alone owns has financed invoices open, and allowed once a co-owner exists", async () => {
    await w.financed();
    const r = await openRequest(w.db, me(), { kind: "erasure" }, gw, T0);
    expect(await erasureBlockers(w.db, me().id)).toEqual([expect.stringContaining("Seller Co has 1 financed invoice still open")]);
    await expect(eraseAccount(w.db, admin, r.id, gw, T0)).rejects.toThrow(/cannot delete yet: Seller Co has 1 financed invoice/);
    const [other] = await w.db.insert(users).values({ name: "Co-owner", email: "co@seller.com", role: "seller", businessId: w.sellerId }).returning();
    await w.db.insert(memberships).values({ userId: other.id, businessId: w.sellerId, orgRole: "owner" });
    expect(await erasureBlockers(w.db, me().id)).toEqual([]);
    await eraseAccount(w.db, admin, r.id, gw, T0);
  });

  it("will not remove the only active administrator", async () => {
    await w.db.update(users).set({ suspendedAt: T0 }).where(eq(users.email, "admin2@marichi.test"));
    expect(await erasureBlockers(w.db, admin.id)).toEqual(["this is the only active administrator"]);
  });
});

describe("retention", () => {
  it("deletes what has outlived its purpose, keeps what has not, and does nothing the second time", async () => {
    const ago = (d: number) => new Date(T0.getTime() - d * DAY);
    await w.db.insert(session).values([
      { expiresAt: ago(40), token: "old", userId: me().id },
      { expiresAt: ago(-5), token: "live", userId: me().id },
    ]);
    await w.db.insert(verification).values([{ identifier: "a", value: "x", expiresAt: ago(10) }, { identifier: "b", value: "y", expiresAt: ago(-1) }]);
    await w.db.insert(notifications).values([
      { userId: me().id, channel: "email", template: "kyb_decision", status: "sent", createdAt: ago(400) },
      { userId: me().id, channel: "email", template: "kyb_decision", status: "sent", createdAt: ago(10) },
      { userId: me().id, channel: "email", template: "kyb_decision", status: "queued", createdAt: ago(400) }, // still to be sent: kept
    ]);
    const r = await openRequest(w.db, me(), { kind: "access" }, gw, ago(40));
    expect(r.exportData).toBeTruthy();
    const n = await runRetention(w.db, T0);
    expect(n).toMatchObject({ sessions: 1, verifications: 1, dataCopies: 1 });
    expect(n.messages).toBeGreaterThanOrEqual(1);
    expect((await w.db.select().from(session)).map((s) => s.token)).toEqual(["live"]);
    expect((await w.db.select().from(notifications)).filter((x) => x.template === "kyb_decision").map((x) => x.status).sort()).toEqual(["queued", "sent"]);
    const [req] = await w.db.select().from(privacyRequests).where(eq(privacyRequests.id, r.id));
    expect(req.exportData).toBeNull();
    expect(req.status).toBe("completed"); // the request itself stays on record
    expect(await runRetention(w.db, T0)).toMatchObject({ sessions: 0, verifications: 0, dataCopies: 0, messages: 0 });
    expect((await w.db.select().from(auditLog).where(eq(auditLog.action, "retention.sweep"))).length).toBe(1);
  });
});
