import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { phoneOtps, users } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { OTP_SMS } from "./templates";

const E164 = /^\+[1-9]\d{9,14}$/;
const TTL_MS = 10 * 60_000;
const MAX_SENDS_PER_HOUR = 3; // stops the endpoint being used to spam an arbitrary number
const MAX_WRONG_GUESSES = 5;
const hash = (userId: string, code: string) => createHash("sha256").update(`${userId}:${code}`).digest();

/** Start phone verification. The code goes straight to the SMS provider: it is never stored or logged in clear. */
export async function requestPhoneOtp(db: Database, userId: string, phone: string, gw: Adapters = gateway, now = new Date()) {
  if (!E164.test(phone)) throw new Error("enter the number in international format, e.g. +919876543210");
  const [prev] = await db.select().from(phoneOtps).where(eq(phoneOtps.userId, userId));
  const sameWindow = prev && now.getTime() - prev.windowStart.getTime() < 3_600_000;
  if (sameWindow && prev.sentCount >= MAX_SENDS_PER_HOUR) throw new Error("too many codes requested; try again in an hour");

  const code = String(randomInt(100_000, 1_000_000));
  const row = {
    userId, phone, codeHash: hash(userId, code).toString("hex"), expiresAt: new Date(now.getTime() + TTL_MS), attempts: 0,
    sentCount: sameWindow ? prev.sentCount + 1 : 1, windowStart: sameWindow ? prev.windowStart : now,
  };
  await db.insert(phoneOtps).values(row).onConflictDoUpdate({ target: phoneOtps.userId, set: row });
  await db.update(users).set({ phone, phoneVerified: false }).where(eq(users.id, userId)); // changing the number un-verifies it
  await gw.notify.send({ channel: "sms", to: phone, template: "phone_otp", data: {}, body: OTP_SMS.text.replace("{{code}}", code), dltTemplateId: OTP_SMS.dltTemplateId });
}

export async function verifyPhoneOtp(db: Database, userId: string, code: string, now = new Date()) {
  const [o] = await db.select().from(phoneOtps).where(eq(phoneOtps.userId, userId));
  if (!o || o.expiresAt <= now) throw new Error("code expired or not requested");
  if (o.attempts >= MAX_WRONG_GUESSES) throw new Error("too many wrong codes; request a new one");
  const ok = /^\d{6}$/.test(code) && timingSafeEqual(hash(userId, code), Buffer.from(o.codeHash, "hex"));
  if (!ok) {
    await db.update(phoneOtps).set({ attempts: o.attempts + 1 }).where(eq(phoneOtps.userId, userId));
    throw new Error("incorrect code");
  }
  await db.transaction(async (tx) => {
    await tx.update(users).set({ phoneVerified: true, phone: o.phone }).where(eq(users.id, userId));
    await tx.delete(phoneOtps).where(eq(phoneOtps.userId, userId));
  });
}
