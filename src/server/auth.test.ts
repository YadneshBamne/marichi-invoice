import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeAuth } from "./auth";
import { testDb } from "./testdb";
import { users } from "./db/schema";

describe("auth schema mapping", () => {
  it("signs up into our users table; clients cannot set role", async () => {
    const db = await testDb();
    const auth = makeAuth(db);
    // `role` is not an accepted input; an attacker-supplied value must not stick.
    const body = { name: "A", email: "a@x.com", password: "correct-horse-battery", role: "admin" } as never;
    const { user } = await auth.api.signUpEmail({ body });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.email).toBe("a@x.com");
    expect(row.role).toBe("seller");
    expect(row.twoFactorEnabled).toBeFalsy();
  });
});
