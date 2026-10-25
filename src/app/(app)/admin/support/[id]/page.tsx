import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { assignTicket, escalateTicket, getTicket, postMessage, resolveTicket } from "@/server/support/service";
import { resolveDispute } from "@/server/support/disputes";
import { canWork } from "@/server/support/policy";
import { KV, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { Thread } from "@/components/ui/thread";
import { formatMoney, rupeesToPaise } from "@/lib/money";

const F = z.object({
  ticketId: z.uuid(),
  action: z.enum(["assign", "reply", "note", "escalate", "resolve", "dispute"]),
  text: z.string().default(""),
  outcome: z.enum(["invoice_stands", "upheld", "credit_note"]).optional(),
  credit: z.string().optional(),
});

async function handle(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "admin", "compliance"]);
  const f = F.parse(Object.fromEntries(fd));
  const staff = { id: u.id, role: u.role, businessId: null };
  if (f.action === "assign") await assignTicket(db, f.ticketId, staff);
  else if (f.action === "reply") await postMessage(db, { ticketId: f.ticketId, actor: staff, body: f.text });
  else if (f.action === "note") await postMessage(db, { ticketId: f.ticketId, actor: staff, body: f.text, internal: true });
  else if (f.action === "escalate") await escalateTicket(db, f.ticketId, staff, f.text);
  else if (f.action === "resolve") await resolveTicket(db, f.ticketId, staff, f.text);
  else await resolveDispute(db, { ticketId: f.ticketId, staff, outcome: f.outcome!, note: f.text, creditNoteAmount: f.credit ? rupeesToPaise(f.credit) : undefined });
  revalidatePath("/admin/support/[id]", "page");
}

const when = (d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const ROLE: Record<string, string> = { seller: "Seller", buyer: "Buyer", financier: "Financier", ops: "Support", admin: "Admin", compliance: "Compliance", system: "System" };

export default async function AdminTicket({ params }: { params: Promise<{ id: string }> }) {
  const u = await requireUser(["ops", "admin", "compliance"]);
  const { id } = await params;
  const data = await getTicket(db, { id: u.id, role: u.role, businessId: null }, id).catch(() => null);
  if (!data) notFound();
  const { ticket: t, no, messages, invoice, dispute } = data;
  const mayWork = canWork(u.role, t.level) && t.status !== "resolved";
  const late = t.slaBreachedAt || t.frBreachedAt;

  return (
    <>
      <PageHead back={{ href: "/admin/support", label: "Support queue" }} title={`${no}  ${t.subject}`}
        sub={<span className="flex flex-wrap items-center gap-2"><StatusPill status={t.status} /><span className="capitalize">{t.kind}</span><span>· level {t.level}</span>{t.assignedTo && <span>· assigned</span>}</span>} />
      {t.ombudsmanEscalatedAt && <div className="mb-5"><Notice tone="bad">The customer escalated to the Ombudsman on {when(t.ombudsmanEscalatedAt)}. Compliance should prepare the response.</Notice></div>}

      <div className="grid gap-5 xl:grid-cols-[1fr_21rem]">
        <div className="space-y-5">
          <Thread messages={messages} who={(m) => ROLE[m.authorRole] ?? m.authorRole} />

          {mayWork ? (
            <Panel title="Respond">
              <form action={handle} className="space-y-3">
                <input type="hidden" name="ticketId" value={t.id} />
                <textarea name="text" rows={4} placeholder="Message to the customer, internal note, escalation reason or resolution note" className="field" />
                <div className="flex flex-wrap gap-2">
                  <button name="action" value="reply" className="btn btn-primary btn-sm">Reply to customer</button>
                  <button name="action" value="note" className="btn btn-ghost btn-sm">Internal note</button>
                  <button name="action" value="assign" formNoValidate className="btn btn-ghost btn-sm">Assign to me</button>
                  <button name="action" value="escalate" className="btn btn-ghost btn-sm">Escalate a level</button>
                  {t.kind !== "dispute" && <button name="action" value="resolve" className="btn btn-ghost btn-sm">Resolve</button>}
                </div>
              </form>
            </Panel>
          ) : (
            <Notice>{t.status === "resolved" ? "This ticket is resolved." : `Level ${t.level} tickets are handled by ${t.level === 1 ? "support" : t.level === 2 ? "a relationship manager (admin)" : "credit and compliance"}. You can view it but not act on it.`}</Notice>
          )}

          {mayWork && t.kind === "dispute" && dispute?.status === "open" && ["ops", "admin"].includes(u.role) && (
            <Panel title={`Resolve dispute (${dispute.phase.replace("_", "-")})`} sub={`Reason given: ${dispute.reason}`}>
              <form action={handle} className="space-y-3">
                <input type="hidden" name="ticketId" value={t.id} />
                <input type="hidden" name="action" value="dispute" />
                <p className="text-sm text-muted">Record the buyer&apos;s agreement in the note.</p>
                <select name="outcome" className="field">
                  <option value="invoice_stands">Invoice stands: release and resume collections</option>
                  <option value="upheld">Dispute upheld: invoice cancelled{dispute.phase === "post_funding" ? " (clawback from seller)" : ""}</option>
                  <option value="credit_note">Credit note agreed (partial)</option>
                </select>
                <input name="credit" inputMode="decimal" placeholder="Credit note amount (₹), only for a credit note" className="field" />
                <textarea name="text" rows={2} required placeholder="Resolution note (required)" className="field" />
                <button className="btn btn-primary btn-sm">Resolve dispute</button>
              </form>
            </Panel>
          )}
        </div>

        <aside className="space-y-5">
          <Panel title="Timers">
            <KV rows={[["First response by", when(t.firstResponseDueAt)], ["Resolve by", <span key="r" className={late ? "text-r-600" : ""}>{when(t.resolveDueAt)}</span>], ...(late ? [["SLA", <StatusPill key="s" status="failed" label="missed" />] as [string, React.ReactNode]] : [])]} />
          </Panel>
          {invoice && (
            <Panel title="Invoice">
              <KV rows={[["Number", invoice.invoiceNumber], ["Amount", formatMoney(invoice.amount)], ["Due", invoice.dueDate], ["Status", <StatusPill key="i" status={invoice.status} />], ...(invoice.disputeFlag ? [["Dispute", <StatusPill key="d" status="disputed" label="flagged" />] as [string, React.ReactNode]] : [])]} />
            </Panel>
          )}
        </aside>
      </div>
    </>
  );
}
