import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { pushSubscriptions } from "../db/schema";

// Our server posts to whatever endpoint a browser gives us, so only the real push services are accepted (no internal addresses).
// Chrome/Edge/Brave/Opera/Samsung use Google's FCM, Firefox its own service, Safari Apple's, and old Edge Windows' WNS.
const PUSH_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];
const MAX_PER_USER = 10;

export const isPushEndpoint = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.port && !u.username && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch { return false; }
};

const key = (len: number, first?: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).refine((v) => {
  const b = Buffer.from(v, "base64url");
  return b.length === len && (first === undefined || b[0] === first);
}, "bad key");

/** What `PushSubscription.toJSON()` gives: an https endpoint at a known push service, the 65-byte public key and the 16-byte auth secret. */
export const PushSubscriptionBody = z.object({
  endpoint: z.string().max(2048).refine(isPushEndpoint, "not a known push service address"),
  keys: z.object({ p256dh: key(65, 4), auth: key(16) }),
});

/** Remember a browser for this person. The same browser signing in as someone else moves the subscription to them. */
export async function savePushSubscription(db: Database, userId: string, sub: z.infer<typeof PushSubscriptionBody>, userAgent?: string | null) {
  const [mine] = await db.select({ n: count() }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  const [known] = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, sub.endpoint)));
  if (!known && mine.n >= MAX_PER_USER) throw new Error("too many browsers are signed up for notifications; turn some off first");
  await db.insert(pushSubscriptions).values({ userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null } });
}

/** A person turns push off in one browser. Only their own subscriptions can be removed. */
export async function removePushSubscription(db: Database, userId: string, endpoint: string) {
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

// For the Web Push adapter (webpushNotify cfg): keys are read at send time so no secret is copied into the outbox.
export async function lookupPushKeys(db: Database, endpoint: string) {
  const [r] = await db.select({ p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  return r ?? null;
}
/** A push service said the subscription is gone. */
export async function dropPushEndpoint(db: Database, endpoint: string) {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}
