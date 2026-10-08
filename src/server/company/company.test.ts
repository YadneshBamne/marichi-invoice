import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { account, auditLog, businesses, session, users } from "../db/schema";
import { world } from "../testkit";
import { addMember, completeSetup, listTeam, resetMemberPassword, setApps, setMemberRole, setSuspended, tempPassword, updateCompany } from "./service";

const hash = async (p: string) => `h:${p}`;
let w: Awaited<ReturnType<typeof world>>;
let owner: { id: string; role: string; orgRole: string; businessId: string | null };
beforeEach(async () => {
  w = await world();
  owner = { id: w.sellerActor.id, role: "seller", orgRole: "owner", businessId: w.sellerId };
});
const row = async (id: string) => (await w.db.select().from(users).where(eq(users.id, id)))[0];

describe("team and credentials", () => {
  it("owner adds a manager with a temporary password that must be changed", async () => {
    const { user, password } = await addMember(w.db, hash, owner, { name: "Meera Rao", email: "Meera@Seller.com", orgRole: "manager" });
    expect(password).toHaveLength(12);
    expect(user).toMatchObject({ email: "meera@seller.com", role: "seller", businessId: w.sellerId, orgRole: "manager", mustChangePassword: true, emailVerified: true });
    const [acct] = await w.db.select().from(account).where(eq(account.userId, user.id));
    expect(acct).toMatchObject({ providerId: "credential", password: `h:${password}` });
    expect((await listTeam(w.db, w.sellerId)).map((t) => t.email)).toContain("meera@seller.com");
    expect(await w.db.select().from(auditLog).where(eq(auditLog.action, "member.added"))).toHaveLength(1);
  });

  it("rejects duplicates, weak passwords, and non-owners", async () => {
    await addMember(w.db, hash, owner, { name: "A One", email: "a@x.com", orgRole: "member" });
    await expect(addMember(w.db, hash, owner, { name: "A Two", email: "A@x.com", orgRole: "member" })).rejects.toThrow(/already/);
    await expect(addMember(w.db, hash, owner, { name: "Bee", email: "b@x.com", orgRole: "member", password: "short" })).rejects.toThrow(/10 characters/);
    await expect(addMember(w.db, hash, { ...owner, orgRole: "manager" }, { name: "Bee", email: "b@x.com", orgRole: "member" })).rejects.toThrow(/not allowed/);
  });

  it("reset password, role change and suspension affect only your own non-owner people", async () => {
    const { user } = await addMember(w.db, hash, owner, { name: "Meera Rao", email: "m@x.com", orgRole: "member" });
    await w.db.insert(session).values({ token: "t1", userId: user.id, expiresAt: new Date(Date.now() + 1e6) });
    await w.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, user.id));
    const r = await resetMemberPassword(w.db, hash, owner, user.id);
    expect((await row(user.id)).mustChangePassword).toBe(true);
    expect((await w.db.select().from(account).where(eq(account.userId, user.id)))[0].password).toBe(`h:${r.password}`);
    expect(await w.db.select().from(session).where(eq(session.userId, user.id))).toHaveLength(0);
    await setMemberRole(w.db, owner, user.id, "manager");
    expect((await row(user.id)).orgRole).toBe("manager");
    await setSuspended(w.db, owner, user.id, true);
    expect((await row(user.id)).suspendedAt).not.toBeNull();
    await setSuspended(w.db, owner, user.id, false);
    expect((await row(user.id)).suspendedAt).toBeNull();
    await expect(setSuspended(w.db, owner, owner.id, true)).rejects.toThrow(/your own/);
    await expect(setSuspended(w.db, { ...owner, businessId: w.buyerId }, user.id, true)).rejects.toThrow(/not found/);
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

  it("temporary passwords are random and unambiguous", () => {
    const a = tempPassword(), b = tempPassword();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-zA-Z2-9]{12}$/);
    expect(a).not.toMatch(/[0OlI1]/);
  });
});
