import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { notifications } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { Empty, PageHead, Pill } from "@/components/ui/cards";

export const metadata = { title: "Notifications" };

export default async function Inbox() {
  const u = await requireUser();
  const rows = await db.select().from(notifications).where(and(eq(notifications.userId, u.id), eq(notifications.channel, "email"))).orderBy(desc(notifications.createdAt)).limit(100);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHead title="Notifications" sub="Everything we have sent you, newest first.">
        <Link className="btn btn-ghost btn-sm" href="/settings/notifications">Preferences</Link>
      </PageHead>
      {rows.length === 0 ? <Empty>Nothing yet. Offers, payouts and payment reminders will appear here.</Empty> : (
        <ul className="stagger divide-y divide-hair overflow-hidden rounded-card bg-card shadow-card">
          {rows.map((n) => (
            <li key={n.id} className="p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="text-[15px]">{n.subject ?? n.template.replaceAll("_", " ")}</b>
                <span className="flex items-center gap-2 text-xs text-faint">
                  {n.critical && <Pill tone="warn">Important</Pill>}
                  {n.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-line text-[14px] text-muted">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
