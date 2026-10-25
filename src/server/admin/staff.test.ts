import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { account, auditLog, invitations, memberships, users } from "../db/schema";
import { gw } from "../testkit";
import { testDb } from "../testdb";
import { acceptAsExistingUser, acceptAsNewUser, previewInvitation } from "../company/invitations";
import { cancelStaffInvitation, inviteStaff, listStaffInvitations, resendStaffInvitation } from "./staff";

const hash = async (p: string) => `h:${p}`;
const T = new Date("2026-10-10T00:00:00Z");
let db: Awaited<ReturnType<typeof testDb>>;
let admin: { id: string; role: string };
const outbox: { to: string; subject?: string; body: string }[] = [];
const spy = { ...gw, notify: { send: async (p: { to: string; subject?: string; body: string }) => { outbox.push(p); } } } as never;
const tokenOf = (n = outbox.length - 1) => /\/invite\/([\w-]+)/.exec(outbox[n].body)![1];

beforeEach(async () => {
  db = await testDb();
  outbox.length = 0;
  const [a] = await db.insert(users).values({ name: "Root", email: "root@marichi.test", role: "admin" }).returning();
  admin = { id: a.id, role: "admin" };
});

describe("inviting staff", () => {
  it("emails one link, keeps only its hash, and tells nobody the credential", async () => {
    const r = await inviteStaff(db, admin, { email: " New.Ops@Marichi.test ", role: "ops" }, spy, T);
    expect(r.emailed).toBe(true);
    expect(outbox[0]).toMatchObject({ to: "new.ops@marichi.test" });
    expect(outbox[0].subject).toContain("Marichi Labs team");
    expect(Object.keys(r)).toEqual(["invitation", "emailed"]);
    const [inv] = await db.select().from(invitations);
    expect(inv).toMatchObject({ businessId: null, staffRole: "ops", status: "pending" });
    expect(inv.tokenHash).toHaveLength(64);
    expect(inv.tokenHash).not.toContain(tokenOf());
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "staff.invited"))).toHaveLength(1);
  });

  it("only an administrator may invite; the role, the address and existing accounts are checked", async () => {
    for (const role of ["ops", "compliance", "seller"]) await expect(inviteStaff(db, { id: admin.id, role }, { email: "a@marichi.test", role: "ops" }, spy, T)).rejects.toThrow(/only an administrator/);
    await expect(inviteStaff(db, admin, { email: "nope", role: "ops" }, spy, T)).rejects.toThrow(/valid email/);
    await expect(inviteStaff(db, admin, { email: "a@marichi.test", role: "seller" as never }, spy, T)).rejects.toThrow(/choose ops/);
    await expect(inviteStaff(db, admin, { email: "root@marichi.test", role: "ops" }, spy, T)).rejects.toThrow(/already has an account/);
  });

  it("a second invitation to the same address replaces the first", async () => {
    await inviteStaff(db, admin, { email: "x@marichi.test", role: "ops" }, spy, T);
    const first = tokenOf();
    await inviteStaff(db, admin, { email: "x@marichi.test", role: "compliance" }, spy, T);
    expect(await listStaffInvitations(db, T)).toMatchObject([{ email: "x@marichi.test", role: "compliance" }]);
    await expect(acceptAsNewUser(db, hash, first, { name: "X", password: "a-long-enough-password" }, T)).rejects.toThrow(/not valid/);
  });
});

describe("joining", () => {
  it("a new person chooses their own name and password and becomes staff with no company", async () => {
    await inviteStaff(db, admin, { email: "new@marichi.test", role: "compliance" }, spy, T);
    const token = tokenOf();
    expect(await previewInvitation(db, token, T)).toMatchObject({ state: "open", staffRole: "compliance", company: "the Marichi Labs team", hasAccount: false });
    const r = await acceptAsNewUser(db, hash, token, { name: "Nia", password: "a-long-enough-password" }, T);
    const [u] = await db.select().from(users).where(eq(users.id, r.userId));
    expect(u).toMatchObject({ role: "compliance", businessId: null, orgRole: null, emailVerified: true });
    expect((await db.select().from(account).where(eq(account.userId, u.id)))[0].password).toBe("h:a-long-enough-password");
    expect(await db.select().from(memberships).where(eq(memberships.userId, u.id))).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "staff.joined"))).toHaveLength(1);
    await expect(acceptAsNewUser(db, hash, token, { name: "Nia", password: "a-long-enough-password" }, T)).rejects.toThrow(/not valid/); // single use
  });

  it("a lapsed link, a short password and an existing customer account are refused", async () => {
    await inviteStaff(db, admin, { email: "late@marichi.test", role: "ops" }, spy, T);
    const token = tokenOf();
    await expect(acceptAsNewUser(db, hash, token, { name: "Late", password: "short" }, T)).rejects.toThrow(/at least 10/);
    await expect(acceptAsNewUser(db, hash, token, { name: "Late", password: "a-long-enough-password" }, new Date(T.getTime() + 11 * 86_400_000))).rejects.toThrow(/expired/);
    const [cust] = await db.insert(users).values({ name: "Cust", email: "late@marichi.test", role: "seller" }).returning();
    await expect(acceptAsExistingUser(db, cust.id, token, T)).rejects.toThrow(/cannot be added to an existing one/);
  });

  it("resending gives a fresh link and kills the old one; cancelling closes it", async () => {
    await inviteStaff(db, admin, { email: "r@marichi.test", role: "ops" }, spy, T);
    const old = tokenOf();
    const [inv] = await db.select().from(invitations);
    await resendStaffInvitation(db, admin, inv.id, spy, new Date(T.getTime() + 86_400_000));
    expect(tokenOf()).not.toBe(old);
    await expect(acceptAsNewUser(db, hash, old, { name: "R", password: "a-long-enough-password" }, T)).rejects.toThrow(/not valid/);
    await cancelStaffInvitation(db, admin, inv.id);
    expect(await listStaffInvitations(db, T)).toHaveLength(0);
    await expect(resendStaffInvitation(db, admin, inv.id, spy, T)).rejects.toThrow(/no longer open/);
    await expect(cancelStaffInvitation(db, { id: admin.id, role: "ops" }, inv.id)).rejects.toThrow(/only an administrator/);
  });
});
