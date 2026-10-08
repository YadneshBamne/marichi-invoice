import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { Card, Pill } from "@/components/ui/cards";
import { ROLE_META } from "@/components/shell/nav";

export const metadata = { title: "Profile" };

async function save(fd: FormData) {
  "use server";
  const u = await requireUser();
  const name = z.string().trim().min(2).max(80).parse(fd.get("name"));
  await db.update(users).set({ name }).where(eq(users.id, u.id));
  revalidatePath("/", "layout");
}

export default async function Profile() {
  const u = await requireUser();
  const [me] = await db.select({ phone: users.phone, verified: users.phoneVerified, created: users.createdAt }).from(users).where(eq(users.id, u.id));
  const meta = ROLE_META[u.role] ?? ROLE_META.seller;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Your details" className="lg:col-span-2">
        <form action={save} className="space-y-4 text-sm">
          <label className="block font-medium">Full name<input name="name" defaultValue={u.name} required minLength={2} className="field font-normal" /></label>
          <label className="block font-medium">Email<input value={u.email} readOnly className="field bg-page font-normal text-muted" /></label>
          <p className="-mt-2 text-xs text-muted">Your sign-in email can&apos;t be changed here. Contact support if it needs to change.</p>
          <button className="btn btn-primary">Save changes</button>
        </form>
      </Card>
      <Card title="Account">
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between"><dt className="text-muted">Account type</dt><dd><Pill tone="good">{meta.label}</Pill></dd></div>
          <div className="flex items-center justify-between"><dt className="text-muted">Mobile</dt><dd>{me.phone ? <>{me.phone} {me.verified ? <Pill tone="good">Verified</Pill> : <Pill tone="warn">Unverified</Pill>}</> : <span className="text-faint">Not added</span>}</dd></div>
          <div className="flex items-center justify-between"><dt className="text-muted">Member since</dt><dd>{me.created.toLocaleDateString("en-IN", { dateStyle: "medium" })}</dd></div>
        </dl>
        <p className="mt-4 text-xs text-muted">Add or verify your mobile number under Notifications.</p>
      </Card>
    </div>
  );
}
