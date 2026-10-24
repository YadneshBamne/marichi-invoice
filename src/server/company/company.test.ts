import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, businesses, memberships, session, users } from "../db/schema";
import { gw, world } from "../testkit";
import { acceptOwnership, cancelOwnershipOffer, completeSetup, listTeam, myCompanies, offerOwnership, pendingOwnership, requestMemberReset, setApps, setDualControl, setMemberRole, setSuspended, switchCompany, updateCompany, type Actor } from "./service";
import { acceptAsExistingUser, acceptAsNewUser, inviteMember } from "./invitations";

const hash = async (p: string) => `h:${p}`;
let w: Awaited<ReturnType<typeof world>>;
let owner: Actor;
beforeEach(async () => {
  w = await world();
  owner = { id: w.sellerActor.id, role: "seller", orgRole: "owner", businessId: w.sellerId };
});
const row = async (id: string) => (await w.db.select().from(users).where(eq(users.id, id)))[0];
const mem = async (userId: string, businessId = w.sellerId) => (await w.db.select().from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.businessId, businessId))))[0];
const actorOf = (u: { id: string }, orgRole: string, role = "seller", businessId: string | null = w.sellerId): Actor => ({ id: u.id, role, orgRole, businessId });

/** Send an invitation and return the link's token, read from the email the gateway was asked to send. */
async function invite(email: string, orgRole: "admin" | "approver" | "maker" | "viewer", by: Actor = owner) {
  const sent: string[] = [];
  const spy = { ...gw, notify: { send: async (p: { body: string }) => { sent.push(p.body); } } } as never;
  await inviteMember(w.db, by, { email, orgRole }, spy);
  return /\/invite\/([\w-]+)/.exec(sent[0])![1];
}
/** A person who joined through the real invitation path. */
async function join(email: string, orgRole: "admin" | "approver" | "maker" | "viewer", by: Actor = owner) {
  const r = await acceptAsNewUser(w.db, hash, await invite(email, orgRole, by), { name: email.split("@")[0] + " Person", password: "a-long-enough-pass" });
  return { id: r.userId, email };
}

describe("roles inside a company", () => {
  it("an admin cannot hand out approver or admin access; only the owner can", async () => {
    const admin = await join("admin@seller.com", "admin");
    const maker = await join("maker@seller.com", "maker");
    const a = actorOf(admin, "admin");
    await expect(setMemberRole(w.db, a, maker.id, "approver")).rejects.toThrow(/not allowed/);
    await setMemberRole(w.db, a, maker.id, "viewer"); // low-power changes are fine
    expect((await mem(maker.id)).orgRole).toBe("viewer");
    await setMemberRole(w.db, owner, maker.id, "approver");
    expect((await mem(maker.id)).orgRole).toBe("approver");
    expect((await row(maker.id)).orgRole).toBe("approver"); // the active-company mirror follows
    await expect(setMemberRole(w.db, a, maker.id, "maker")).rejects.toThrow(/not allowed/); // taking approver away is also the owner's
  });

  it("the owner's access cannot be changed, and nobody changes their own", async () => {
    const admin = await join("admin@seller.com", "admin");
    await expect(setMemberRole(w.db, actorOf(admin, "admin"), owner.id, "maker")).rejects.toThrow(/owner access/);
    await expect(setMemberRole(w.db, owner, owner.id, "maker")).rejects.toThrow(/your own/);
    await expect(setMemberRole(w.db, owner, admin.id, "owner" as never)).rejects.toThrow(/choose admin/);
  });

  it("suspension is per company, immediate, and audited", async () => {
    const maker = await join("maker@seller.com", "maker");
    await w.db.insert(session).values({ token: "t1", userId: maker.id, expiresAt: new Date(Date.now() + 1e6) });
    await setSuspended(w.db, owner, maker.id, true);
    expect((await mem(maker.id)).suspendedAt).not.toBeNull();
    expect(await w.db.select().from(session).where(eq(session.userId, maker.id))).toHaveLength(0); // no other company: signed out everywhere
    await setSuspended(w.db, owner, maker.id, false);
    expect((await mem(maker.id)).suspendedAt).toBeNull();
    expect((await w.db.select().from(auditLog).where(eq(auditLog.action, "member.suspended")))).toHaveLength(1);
    await expect(setSuspended(w.db, owner, owner.id, true)).rejects.toThrow(/your own/);
    await expect(setSuspended(w.db, { ...owner, businessId: w.buyerId }, maker.id, true)).rejects.toThrow(/not found/);
  });

  it("an admin cannot suspend an approver", async () => {
    const admin = await join("admin@seller.com", "admin");
    const appr = await join("appr@seller.com", "approver");
    await expect(setSuspended(w.db, actorOf(admin, "admin"), appr.id, true)).rejects.toThrow(/not allowed/);
  });

  it("nobody types another person's password: a reset is a link sent to their own email", async () => {
    const maker = await join("maker@seller.com", "maker");
    const sent: string[] = [];
    await requestMemberReset(w.db, owner, maker.id, async (e) => { sent.push(e); });
    expect(sent).toEqual(["maker@seller.com"]);
    await expect(requestMemberReset(w.db, actorOf(maker, "maker"), owner.id, async () => {})).rejects.toThrow(/not allowed/);
  });

  it("the team list shows the role each person holds here", async () => {
    await join("maker@seller.com", "maker");
    const t = await listTeam(w.db, w.sellerId);
    expect(t.map((x) => [x.email, x.orgRole]).sort()).toEqual([["maker@seller.com", "maker"], ["s@seller.com", "owner"]]);
  });
});

describe("one person, several companies", () => {
  it("accepting an invitation adds a company; the switcher moves between them and carries the role and company type", async () => {
    // The same login is invited into the buyer company as an approver.
    const token = await invite("s@seller.com", "approver", actorOf({ id: w.buyerUserId }, "owner", "buyer", w.buyerId));
    await expect(acceptAsExistingUser(w.db, w.buyerUserId, token)).rejects.toThrow(/different email/); // wrong person
    await acceptAsExistingUser(w.db, owner.id, token);

    const me = await row(owner.id);
    expect(me).toMatchObject({ businessId: w.buyerId, role: "buyer", orgRole: "approver" }); // now working as a buyer approver
    expect((await myCompanies(w.db, owner.id)).map((c) => c.id).sort()).toEqual([w.buyerId, w.sellerId].sort());

    await switchCompany(w.db, owner.id, w.sellerId);
    expect(await row(owner.id)).toMatchObject({ businessId: w.sellerId, role: "seller", orgRole: "owner" });
  });

  it("cannot switch into a company you do not belong to or were suspended from", async () => {
    await expect(switchCompany(w.db, owner.id, w.buyerId)).rejects.toThrow(/do not have access/);
  });

  it("suspended in one company, a person lands in their other company instead of being signed out", async () => {
    const m = await join("both@seller.com", "maker");
    await w.db.insert(memberships).values({ userId: m.id, businessId: w.buyerId, orgRole: "viewer" });
    await w.db.update(businesses).set({ kind: "buyer" }).where(eq(businesses.id, w.buyerId));
    await w.db.insert(session).values({ token: "keep", userId: m.id, expiresAt: new Date(Date.now() + 1e6) });
    await setSuspended(w.db, owner, m.id, true);
    expect(await row(m.id)).toMatchObject({ businessId: w.buyerId, orgRole: "viewer", role: "buyer" });
    expect(await w.db.select().from(session).where(eq(session.userId, m.id))).toHaveLength(1);
  });
});

describe("ownership", () => {
  it("is offered to an admin or approver and moves only when they accept; exactly one owner remains", async () => {
    const appr = await join("appr@seller.com", "approver");
    const maker = await join("maker@seller.com", "maker");
    await expect(offerOwnership(w.db, owner, maker.id)).rejects.toThrow(/admin or an approver/);
    await expect(offerOwnership(w.db, actorOf(appr, "approver"), maker.id)).rejects.toThrow(/only the owner/);
    await offerOwnership(w.db, owner, appr.id);
    expect((await pendingOwnership(w.db, w.sellerId))?.toUserId).toBe(appr.id);
    expect((await mem(owner.id)).orgRole).toBe("owner"); // nothing has moved yet
    await expect(acceptOwnership(w.db, actorOf(maker, "maker"))).rejects.toThrow(/no ownership offer/);
    await acceptOwnership(w.db, actorOf(appr, "approver"));
    expect((await mem(appr.id)).orgRole).toBe("owner");
    expect((await mem(owner.id)).orgRole).toBe("admin");
    expect((await row(appr.id)).orgRole).toBe("owner");
    const t = await listTeam(w.db, w.sellerId);
    expect(t.filter((x) => x.orgRole === "owner")).toHaveLength(1);
  });

  it("an offer can be withdrawn and expires", async () => {
    const appr = await join("appr@seller.com", "approver");
    await offerOwnership(w.db, owner, appr.id, new Date("2026-10-01T00:00:00Z"));
    expect(await pendingOwnership(w.db, w.sellerId, new Date("2026-10-20T00:00:00Z"))).toBeNull();
    await expect(acceptOwnership(w.db, actorOf(appr, "approver"), new Date("2026-10-20T00:00:00Z"))).rejects.toThrow(/no ownership offer/);
    await offerOwnership(w.db, owner, appr.id);
    await cancelOwnershipOffer(w.db, owner);
    expect(await pendingOwnership(w.db, w.sellerId)).toBeNull();
  });
});

describe("company profile, apps and setup", () => {
  it("setup needs a name; apps are cleaned to what exists for the company type", async () => {
    await expect(completeSetup(w.db, owner)).rejects.toThrow(/name/);
    await updateCompany(w.db, owner, { displayName: "  Asha Traders  ", city: "Pune" });
    await setApps(w.db, owner, ["support", "buyer-only-nonsense", "analytics", "confirmations", "support"]);
    await completeSetup(w.db, owner, new Date("2026-10-08T00:00:00Z"));
    const [b] = await w.db.select().from(businesses).where(eq(businesses.id, w.sellerId));
    expect(b).toMatchObject({ displayName: "Asha Traders", city: "Pune", apps: ["support", "analytics"] });
    expect(b.setupCompletedAt).toEqual(new Date("2026-10-08T00:00:00Z"));
  });

  it("only the owner switches dual control, and it is audited", async () => {
    const admin = await join("admin@seller.com", "admin");
    await expect(setDualControl(w.db, actorOf(admin, "admin"), true)).rejects.toThrow(/not allowed/);
    await setDualControl(w.db, owner, true);
    expect((await w.db.select().from(businesses).where(eq(businesses.id, w.sellerId)))[0].dualControl).toBe(true);
    expect(await w.db.select().from(auditLog).where(eq(auditLog.action, "company.dual_control"))).toHaveLength(1);
  });
});
