import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { getPreferences, setPreference } from "@/server/notify";
import { requestPhoneOtp, verifyPhoneOtp } from "@/server/notify/phone";
import { PushToggle } from "./push-toggle";

async function savePrefs(fd: FormData) {
  "use server";
  const u = await requireUser();
  await setPreference(db, u.id, "email", fd.get("email") === "on");
  await setPreference(db, u.id, "sms", fd.get("sms") === "on");
  await setPreference(db, u.id, "whatsapp", fd.get("whatsapp") === "on"); // WhatsApp is opt-in: unticked means off
  revalidatePath("/settings/notifications");
}
async function sendCode(fd: FormData) {
  "use server";
  const u = await requireUser();
  await requestPhoneOtp(db, u.id, z.string().trim().parse(fd.get("phone")));
  revalidatePath("/settings/notifications");
}
async function verify(fd: FormData) {
  "use server";
  const u = await requireUser();
  await verifyPhoneOtp(db, u.id, z.string().trim().parse(fd.get("code")));
  revalidatePath("/settings/notifications");
}

const input = "field-inline";
export default async function NotificationSettings() {
  const u = await requireUser();
  const [me] = await db.select({ phone: users.phone, verified: users.phoneVerified }).from(users).where(eq(users.id, u.id));
  const prefs = await getPreferences(db, u.id);

  return (
    <div className="grid gap-4 text-sm lg:grid-cols-2">
      <section className="space-y-3 rounded-card bg-card p-5 shadow-card">
        <h2 className="font-medium">Mobile number (for SMS)</h2>
        {me.phone && <p>{me.phone} · {me.verified ? <span className="text-p-700">verified</span> : <span className="text-s-600">not verified</span>}</p>}
        <form action={sendCode} className="flex gap-2">
          <input name="phone" placeholder="+919876543210" required className={input} />
          <button className="btn btn-ghost btn-sm">Send code</button>
        </form>
        {me.phone && !me.verified && (
          <form action={verify} className="flex gap-2">
            <input name="code" inputMode="numeric" placeholder="6-digit code" required className={input} />
            <button className="btn btn-primary btn-sm">Verify</button>
          </form>
        )}
      </section>

      <form action={savePrefs} className="space-y-2 rounded-card bg-card p-5 shadow-card">
        <h2 className="font-medium">Channels</h2>
        <label className="flex gap-2"><input name="email" type="checkbox" defaultChecked={prefs.email} />Email</label>
        <label className="flex gap-2"><input name="sms" type="checkbox" defaultChecked={prefs.sms} />SMS</label>
        <label className="flex gap-2"><input name="whatsapp" type="checkbox" defaultChecked={prefs.whatsapp} disabled={!me.verified} />WhatsApp</label>
        <p className="text-muted">WhatsApp is off until you tick it, and only works with a verified mobile number{me.verified ? "" : " (verify yours first)"}. We message that number on WhatsApp, so it must have WhatsApp.</p>
        <p className="text-muted">Important notices (payouts, payment due or overdue, legal notices) are always sent on every channel you have, except WhatsApp, which needs your tick.</p>
        <button className="btn btn-ghost btn-sm">Save</button>
      </form>

      <PushToggle />

      <p className="text-muted lg:col-span-2">Looking for past messages? They&apos;re in your <a className="font-semibold text-p-700 underline" href="/notifications">notification inbox</a>.</p>
    </div>
  );
}
