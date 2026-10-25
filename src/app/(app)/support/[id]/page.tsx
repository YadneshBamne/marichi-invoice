import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireApp, requireUser } from "@/server/rbac";
import { escalateToOmbudsman, getTicket, postMessage, reopenTicket } from "@/server/support/service";
import { formatMoney } from "@/lib/money";
import { KV, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { Thread } from "@/components/ui/thread";

const Id = z.uuid();
async function reply(fd: FormData) {
  "use server";
  const u = await requireUser(["seller", "buyer", "financier"]);
  requireApp(u, "support");
  await postMessage(db, { ticketId: Id.parse(fd.get("ticketId")), actor: u, body: String(fd.get("body") ?? "") });
  revalidatePath("/support/[id]", "page");
}
async function reopen(fd: FormData) {
  "use server";
  const u = await requireUser(["seller", "buyer", "financier"]);
  requireApp(u, "support");
  await reopenTicket(db, Id.parse(fd.get("ticketId")), u);
  revalidatePath("/support/[id]", "page");
}
async function ombudsman(fd: FormData) {
  "use server";
  const u = await requireUser(["seller", "buyer", "financier"]);
  requireApp(u, "support");
  await escalateToOmbudsman(db, Id.parse(fd.get("ticketId")), u);
  revalidatePath("/support/[id]", "page");
}

const when = (d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const who = (m: { authorRole: string }) => (m.authorRole === "system" ? "System" : ["ops", "admin", "compliance"].includes(m.authorRole) ? "Marichi support" : "You");

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await requireUser(["seller", "buyer", "financier"]);
  requireApp(u, "support");
  const { id } = await params;
  const data = await getTicket(db, u, id).catch(() => null);
  if (!data) notFound();
  const { ticket: t, no, messages, invoice, dispute } = data;
  const mineToReopen = t.businessId === u.businessId && t.status === "resolved" && t.kind !== "dispute";
  const canOmbudsman = t.businessId === u.businessId && ["grievance", "complaint"].includes(t.kind) && !t.ombudsmanEscalatedAt && (t.status === "resolved" || new Date() > t.resolveDueAt);

  return (
    <>
      <PageHead back={{ href: "/support", label: "All tickets" }} title={`${no}  ${t.subject}`}
        sub={<span className="flex flex-wrap items-center gap-2"><StatusPill status={t.status} /><span className="capitalize">{t.kind}</span></span>} />
      {dispute && <div className="mb-5"><Notice tone="warn">Dispute {dispute.status}{dispute.outcome && ` (${dispute.outcome.replaceAll("_", " ")})`}. {dispute.status === "open" && "Financing and collection reminders on this invoice are paused until it is resolved."}</Notice></div>}

      <div className="grid gap-5 xl:grid-cols-[1fr_21rem]">
        <div className="space-y-5">
          <Thread messages={messages.filter((m) => !m.internal)} who={who} />
          {t.status !== "resolved" && (
            <Panel title="Reply">
              <form action={reply} className="space-y-3">
                <input type="hidden" name="ticketId" value={t.id} />
                <textarea name="body" rows={4} required className="field" placeholder="Write your reply" />
                <button className="btn btn-primary">Send reply</button>
              </form>
            </Panel>
          )}
          <div className="flex flex-wrap gap-3">
            {mineToReopen && <form action={reopen}><input type="hidden" name="ticketId" value={t.id} /><button className="btn btn-ghost btn-sm">Not resolved? Reopen</button></form>}
            {canOmbudsman && <form action={ombudsman}><input type="hidden" name="ticketId" value={t.id} /><button className="btn btn-ghost btn-sm text-r-600">Escalate to the Ombudsman</button></form>}
          </div>
        </div>
        <aside className="space-y-5">
          <Panel title="Timeline"><KV rows={[["We aim to respond by", when(t.firstResponseDueAt)], ["We aim to resolve by", when(t.resolveDueAt)]]} /></Panel>
          {invoice && <Panel title="Invoice"><KV rows={[["Number", invoice.invoiceNumber], ["Amount", formatMoney(invoice.amount)], ["Status", <StatusPill key="s" status={invoice.status} />]]} /></Panel>}
        </aside>
      </div>
    </>
  );
}
