import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { invoices } from "@/server/db/schema";
import { requireApp, requireUser } from "@/server/rbac";
import { listMyTickets, openTicket } from "@/server/support/service";
import { ticketNo } from "@/server/support/policy";
import { DataTable, Field, PageHead, Panel, StatusPill } from "@/components/ui/page";

const Form = z.object({
  kind: z.enum(["query", "complaint", "grievance"]),
  subject: z.string().min(3).max(120),
  description: z.string().min(5).max(4000),
  invoiceId: z.string().optional(),
});

async function create(fd: FormData) {
  "use server";
  const u = await requireUser(["seller", "buyer", "financier"]);
  requireApp(u, "support");
  const f = Form.parse(Object.fromEntries(fd));
  const t = await openTicket(db, u, { ...f, invoiceId: f.invoiceId || undefined });
  revalidatePath("/support");
  redirect(`/support/${t.id}`);
}

const input = "field font-normal";
const ago = (d: Date) => d.toLocaleDateString("en-IN", { dateStyle: "medium" });

export default async function Support({ searchParams }: { searchParams: Promise<{ invoice?: string }> }) {
  const u = await requireUser(["seller", "buyer", "financier"]);
  requireApp(u, "support");
  const preselect = (await searchParams).invoice;
  const [mine, myInvoices] = await Promise.all([
    listMyTickets(db, u),
    u.businessId ? db.select({ id: invoices.id, no: invoices.invoiceNumber }).from(invoices).where(or(eq(invoices.sellerId, u.businessId), eq(invoices.buyerId, u.businessId))) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHead title="Support" sub="Ask a question, make a complaint or raise a formal grievance. Every request is a tracked ticket with a response time." />
      <div className="grid gap-5 xl:grid-cols-[1fr_26rem]">
        <Panel title="Your requests" sub={`${mine.length} ticket${mine.length === 1 ? "" : "s"}`} flush>
          <DataTable rows={mine} rowKey={(t) => t.id} empty="No tickets yet. Use the form to raise one."
            cols={[
              { h: "Ticket", cell: (t) => <Link className="hover:underline" href={`/support/${t.id}`}>{ticketNo(t.seq)}<span className="block max-w-xs truncate text-[13px] font-normal text-muted">{t.subject}</span></Link> },
              { h: "Type", cell: (t) => <span className="capitalize">{t.kind}</span> },
              { h: "Status", cell: (t) => <StatusPill status={t.status} /> },
              { h: "Opened", cell: (t) => <span className="font-normal text-muted">{ago(t.createdAt)}</span> },
            ]} />
        </Panel>

        <Panel title="New request">
          <form action={create} className="space-y-4">
            <Field label="Type"><select name="kind" className={input}><option value="query">Question</option><option value="complaint">Complaint</option><option value="grievance">Formal grievance</option></select></Field>
            <Field label="Related invoice" hint="Optional"><select name="invoiceId" defaultValue={preselect ?? ""} className={input}><option value="">None</option>{myInvoices.map((i) => <option key={i.id} value={i.id}>{i.no}</option>)}</select></Field>
            <Field label="Subject"><input name="subject" required className={input} /></Field>
            <Field label="Details"><textarea name="description" rows={5} required className={input} /></Field>
            <button className="btn btn-primary w-full">Submit request</button>
            <p className="text-xs text-muted">Disputing an invoice? Do that from the invoice itself. See our <Link className="font-semibold text-p-700 underline" href="/grievance">grievance redressal process</Link>.</p>
          </form>
        </Panel>
      </div>
    </>
  );
}
