import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { account, auditLog, invitations, memberships, users } from "../db/schema";
import { gw, world } from "../testkit";
import type { Actor } from "./service";
import { acceptAsExistingUser, acceptAsNewUser, cancelInvitation, INVITE_DAYS, inviteMember, listInvitations, previewInvitation, resendInvitation } from "./invitations";

const hash = async (p: string) => `h:${p}`;
let w: Awaited<ReturnType<typeof world>>;
let owner: Actor;
const T = new Date("2026-10-10T00:00:00Z");
beforeEach(async () => { w = await world(); owner = { id: w.sellerActor.id, role: "seller", orgRole: "owner", businessId: w.sellerId }; });

const outbox: { to: string; subject?: string; body: string }[] = [];
const spy = { ...gw, notify: { send: async (p: { to: string; subject?: string; body: string }) => { outbox.push(p); } } } as never;
const tokenOf = (n = outbox.length - 1) => /\/invite\/([\w-]+)/.exec(outbox[n].body)![1];
beforeEach(() => { outbox.length = 0; });
const send = (email: string, orgRole: "admin" | "approver" | "maker" | "viewer" = "maker", by: Actor = owner, now = T) => inviteMember(w.db, by, { email, orgRole }, spy, now);

describe("inviting", () => {
  it("emails a single link, stores only its hash, and never hands the credential to the inviter", async () => {
    const r = await send("Maya@Seller.com");
    expect(r.emailed).toBe(true);
    expect(outbox[0]).toMatchObject({ to: "maya@seller.com" });
    expect(outbox[0].subject).toContain("invited you");
    const token = tokenOf();
    const [inv] = await w.db.select().from(invitations);
    expect(inv.tokenHash).not.toContain(token); // only a hash is kept
    expect(inv.tokenHash).toHaveLength(64);
    expect(inv.expiresAt.getTime() - T.getTime()).toBe(INVITE_DAYS * 86_400_000);
    expect(Object.keys(r)).toEqual(["invitation", "emailed"]); // no link or token comes back to the caller
    expect(await w.db.select().from(auditLog).where(eq(auditLog.action, "member.invited"))).toHaveLength(1);
  });

  it("an admin may invite makers and viewers but not approvers or admins", async () => {
    const adminId = (await w.db.insert(users).values({ name: "Ad", email: "ad@seller.com", role: "seller", businessId: w.sellerId, orgRole: "admin" }).returning())[0].id;
    await w.db.insert(memberships).values({ userId: adminId, businessId: w.sellerId, orgRole: "admin" });
    const admin: Actor = { id: adminId, role: "seller", orgRole: "admin", businessId: w.sellerId };
    await send("a@seller.com", "maker", admin);
    await send("b@seller.com", "viewer", admin);
    await expect(send("c@seller.com", "approver", admin)).rejects.toThrow(/not allowed/);
    await expect(send("d@seller.com", "admin", admin)).rejects.toThrow(/not allowed/);
    await send("c@seller.com", "approver", owner); // the owner can
  });

  it("makers, approvers and viewers cannot invite at all", async () => {
    for (const orgRole of ["maker", "approver", "viewer"]) await expect(send("x@seller.com", "maker", { ...owner, orgRole })).rejects.toThrow(/not allowed/);
  });

  it("rejects bad emails, the owner role, existing members and duplicate pending invitations", async () => {
    await expect(send("not-an-email")).rejects.toThrow(/valid email/);
    await expect(inviteMember(w.db, owner, { email: "z@seller.com", orgRole: "owner" as never }, spy, T)).rejects.toThrow(/choose admin/);
    await expect(send("s@seller.com")).rejects.toThrow(/already part/);
    await send("dup@seller.com");
    await expect(send("DUP@seller.com")).rejects.toThrow(/already invited/);
  });

  it("an expired invitation does not block a new one", async () => {
    await send("late@seller.com");
    await send("late@seller.com", "maker", owner, new Date(T.getTime() + (INVITE_DAYS + 1) * 86_400_000));
    expect((await listInvitations(w.db, w.sellerId, new Date(T.getTime() + (INVITE_DAYS + 1) * 86_400_000))).filter((i) => i.email === "late@seller.com")).toHaveLength(1);
  });

  it("an email failure keeps the invitation and says so, so the inviter can resend", async () => {
    const broken = { ...gw, notify: { send: async () => { throw new Error("provider down"); } } } as never;
    const r = await inviteMember(w.db, owner, { email: "x@seller.com", orgRole: "maker" }, broken, T);
    expect(r.emailed).toBe(false);
    expect(await listInvitations(w.db, w.sellerId, T)).toHaveLength(1);
  });
});

describe("accepting as a new person", () => {
  it("they choose their own name and password; they land in the company with the invited role, verified, with no forced password change", async () => {
    await send("maya@seller.com", "approver");
    const r = await acceptAsNewUser(w.db, hash, tokenOf(), { name: "Maya Rao", password: "my-own-password" }, T);
    const [u] = await w.db.select().from(users).where(eq(users.id, r.userId));
    expect(u).toMatchObject({ email: "maya@seller.com", name: "Maya Rao", role: "seller", businessId: w.sellerId, orgRole: "approver", emailVerified: true, mustChangePassword: false, twoFactorEnabled: false });
    expect((await w.db.select().from(account).where(eq(account.userId, u.id)))[0]).toMatchObject({ providerId: "credential", password: "h:my-own-password" });
    expect((await w.db.select().from(memberships).where(and(eq(memberships.userId, u.id), eq(memberships.businessId, w.sellerId))))[0].orgRole).toBe("approver");
    expect((await w.db.select().from(invitations))[0]).toMatchObject({ status: "accepted", acceptedBy: u.id });
    expect(await w.db.select().from(auditLog).where(eq(auditLog.action, "member.joined"))).toHaveLength(1);
  });

  it("the link works once", async () => {
    await send("maya@seller.com");
    await acceptAsNewUser(w.db, hash, tokenOf(), { name: "Maya Rao", password: "my-own-password" }, T);
    await expect(acceptAsNewUser(w.db, hash, tokenOf(), { name: "Maya Rao", password: "my-own-password" }, T)).rejects.toThrow(/not valid/);
  });

  it("expires after ten days, and a wrong or cancelled link does nothing", async () => {
    await send("maya@seller.com");
    const token = tokenOf();
    await expect(acceptAsNewUser(w.db, hash, token, { name: "Maya Rao", password: "my-own-password" }, new Date(T.getTime() + 11 * 86_400_000))).rejects.toThrow(/expired/);
    await expect(acceptAsNewUser(w.db, hash, "nonsense-token-value-not-real-0000", { name: "Maya Rao", password: "my-own-password" }, T)).rejects.toThrow(/not valid/);
    await cancelInvitation(w.db, owner, (await w.db.select().from(invitations))[0].id);
    await expect(acceptAsNewUser(w.db, hash, token, { name: "Maya Rao", password: "my-own-password" }, T)).rejects.toThrow(/not valid/);
  });

  it("needs a real name and a strong enough password; an existing account is told to sign in", async () => {
    await send("maya@seller.com");
    await expect(acceptAsNewUser(w.db, hash, tokenOf(), { name: "M", password: "my-own-password" }, T)).rejects.toThrow(/name/);
    await expect(acceptAsNewUser(w.db, hash, tokenOf(), { name: "Maya Rao", password: "short" }, T)).rejects.toThrow(/10 characters/);
    await send("s@seller.com", "maker", { ...owner, businessId: w.buyerId, id: w.buyerUserId }); // s@seller.com already has an account (the seller's owner)
    await expect(acceptAsNewUser(w.db, hash, tokenOf(), { name: "Sam Seller", password: "my-own-password" }, T)).rejects.toThrow(/already have an account/);
  });
});

describe("resend, cancel and preview", () => {
  it("resend gives a fresh link and fresh ten days; the old link stops working", async () => {
    await send("maya@seller.com");
    const first = tokenOf();
    const [inv] = await w.db.select().from(invitations);
    await resendInvitation(w.db, owner, inv.id, spy, new Date(T.getTime() + 8 * 86_400_000));
    const second = tokenOf();
    expect(second).not.toBe(first);
    await expect(acceptAsNewUser(w.db, hash, first, { name: "Maya Rao", password: "my-own-password" }, T)).rejects.toThrow(/not valid/);
    const [after] = await w.db.select().from(invitations);
    expect(after.expiresAt.getTime()).toBe(T.getTime() + 18 * 86_400_000);
    await acceptAsNewUser(w.db, hash, second, { name: "Maya Rao", password: "my-own-password" }, new Date(T.getTime() + 12 * 86_400_000));
  });

  it("only the owner can cancel or resend an invitation to a powerful role", async () => {
    await send("appr@seller.com", "approver");
    const [inv] = await w.db.select().from(invitations);
    const adminId = (await w.db.insert(users).values({ name: "Ad", email: "ad@seller.com", role: "seller", businessId: w.sellerId, orgRole: "admin" }).returning())[0].id;
    const admin: Actor = { id: adminId, role: "seller", orgRole: "admin", businessId: w.sellerId };
    await expect(cancelInvitation(w.db, admin, inv.id)).rejects.toThrow(/not allowed/);
    await expect(resendInvitation(w.db, admin, inv.id, spy)).rejects.toThrow(/not allowed/);
    await cancelInvitation(w.db, owner, inv.id);
  });

  it("a different company cannot touch your invitation", async () => {
    await send("maya@seller.com");
    const [inv] = await w.db.select().from(invitations);
    await expect(cancelInvitation(w.db, { ...owner, businessId: w.buyerId }, inv.id)).rejects.toThrow(/no longer open/);
  });

  it("the invitee sees the company, role and whether they already have an account", async () => {
    await send("maya@seller.com", "viewer");
    expect(await previewInvitation(w.db, tokenOf(), T)).toMatchObject({ state: "open", orgRole: "viewer", email: "maya@seller.com", hasAccount: false, company: "Seller Co" });
    expect(await previewInvitation(w.db, tokenOf(), new Date(T.getTime() + 11 * 86_400_000))).toMatchObject({ state: "expired" });
    expect(await previewInvitation(w.db, "nonsense-token-value-not-real-0000")).toBeNull();
    await send("s@seller.com", "maker", { ...owner, businessId: w.buyerId, id: w.buyerUserId });
    expect((await previewInvitation(w.db, tokenOf(), T))?.hasAccount).toBe(true);
  });
});

describe("accepting with an existing account", () => {
  it("must be signed in as the invited address, cannot be platform staff", async () => {
    await send("s@seller.com", "approver", { ...owner, businessId: w.buyerId, id: w.buyerUserId });
    const token = tokenOf();
    await expect(acceptAsExistingUser(w.db, w.buyerUserId, token, T)).rejects.toThrow(/different email/);
    const ops = (await w.db.insert(users).values({ name: "Ops", email: "s@seller.com.ops", role: "ops" }).returning())[0];
    await expect(acceptAsExistingUser(w.db, ops.id, token, T)).rejects.toThrow(/different email/);
    await acceptAsExistingUser(w.db, owner.id, token, T);
    expect(await w.db.select().from(memberships).where(eq(memberships.userId, owner.id))).toHaveLength(2);
  });
});
