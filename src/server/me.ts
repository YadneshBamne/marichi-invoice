import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { businesses, users } from "./db/schema";
import { getSession } from "./session";

/**
 * The signed-in person as the database sees them right now (role, company role, suspension, company branding), in ONE
 * query shared by the layout and every guard in the request. Role and suspension never come from the cached session cookie.
 */
export const getMe = cache(async () => {
  const s = await getSession();
  if (!s) return null;
  const [r] = await db.select({
    id: users.id, name: users.name, email: users.email, role: users.role, orgRole: users.orgRole, businessId: users.businessId,
    suspendedAt: users.suspendedAt, mustChangePassword: users.mustChangePassword, tourSeenAt: users.tourSeenAt, twoFactorEnabled: users.twoFactorEnabled,
    biz: {
      legalName: businesses.legalName, displayName: businesses.displayName, logoRef: businesses.logoRef, apps: businesses.apps,
      setupCompletedAt: businesses.setupCompletedAt, kybStatus: businesses.kybStatus,
    },
  }).from(users).leftJoin(businesses, eq(businesses.id, users.businessId)).where(eq(users.id, s.user.id));
  return r ?? null;
});
export type Me = NonNullable<Awaited<ReturnType<typeof getMe>>>;
