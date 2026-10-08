"use server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/server/auth";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";

/** Called when the tour is finished or skipped, so it doesn't open by itself again. Replaying never clears this. */
export async function completeTour() {
  const s = await auth.api.getSession({ headers: await headers() });
  if (!s) return;
  await db.update(users).set({ tourSeenAt: new Date() }).where(eq(users.id, s.user.id));
}
