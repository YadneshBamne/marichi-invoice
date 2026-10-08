import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, users } from "../db/schema";
import { world } from "../testkit";
import { listUsers, searchAudit, setStaffRole, systemHealth } from "./service";

let w: Awaited<ReturnType<typeof world>>;
let admin: { id: string; role: string }, ops: { id: string };
beforeEach(async () => {
  w = await world();
  const [a, o] = await w.db.insert(users).values([
    { name: "A", email: "a@m.com", role: "admin" }, { name: "O", email: "o@m.com", role: "ops" },
  ]).returning();
  admin = { id: a.id, role: "admin" }; ops = o;
});

describe("admin hub", () => {
  it("changes a staff role and audits it", async () => {
    await setStaffRole(w.db, admin, ops.id, "compliance");
    expect((await w.db.select().from(users).where(eq(users.id, ops.id)))[0].role).toBe("compliance");
    const [a] = await searchAudit(w.db, { action: "role_changed" });
    expect(a).toMatchObject({ entity: "user", before: { role: "ops" }, after: { role: "compliance" } });
  });
  it("refuses: non-admin, self, customers", async () => {
    await expect(setStaffRole(w.db, { id: ops.id, role: "ops" }, admin.id, "ops")).rejects.toThrow(/only an admin/);
    await expect(setStaffRole(w.db, admin, admin.id, "ops")).rejects.toThrow(/own role/);
    await expect(setStaffRole(w.db, admin, w.sellerActor.id, "admin")).rejects.toThrow(/only staff/);
    expect(await w.db.select().from(auditLog).where(eq(auditLog.action, "user.role_changed"))).toHaveLength(0);
  });
  it("lists users, filters by email, reports health", async () => {
    expect((await listUsers(w.db, "o@m")).map((u) => u.email)).toEqual(["o@m.com"]);
    expect(await systemHealth(w.db)).toMatchObject({ queued: expect.any(Number), failedPayouts: 0, workerLastRun: null, integrationsMode: "mock" });
  });
});
