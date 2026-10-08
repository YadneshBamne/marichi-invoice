"use server";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { getSession } from "@/server/session";

/** Called after the password was changed through Better Auth: the owner-issued temporary password no longer applies. */
export async function clearMustChangePassword() {
  const s = await getSession();
  if (!s) return;
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, s.user.id));
}
