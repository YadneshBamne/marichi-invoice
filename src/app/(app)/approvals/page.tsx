import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { can } from "@/server/permissions";
import { cancel, decide, listRequests } from "@/server/approvals/service";
import { DataTable, EmptyState, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { formatMoney } from "@/lib/money";
import { attempt } from "../financier/attempt";

export const metadata = { title: "Approvals" };
const PATH = "/approvals";
const KIND: Record<string, string> = {
  "offer.accept": "Accept an offer", "offer.accept_many": "Accept several offers", "bid.accept": "Choose a financier's bid", "bid.accept_group": "Combine financiers' bids", "bundle.bid": "Bid on a bundle of invoices", "bundle.accept": "Accept a financier's bids on a bundle",
  "bid.place": "Place a bid", "earlypay.propose": "Propose early payment",
};

async function act(fd: FormData) {
  "use server";
  const u = await requireUser(["seller", "buyer", "financier"]);
  await attempt(PATH, async () => {
    const f = z.object({ id: z.uuid(), action: z.enum(["approve", "reject", "cancel"]), note: z.string().max(300).optional() }).parse(Object.fromEntries(fd));
    const a = { id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId };
    if (f.action === "cancel") { await cancel(db, a, f.id); return "Request withdrawn."; }
    const r = await decide(db, a, f.id, f.action, f.note ?? "");
    if (r.status === "failed") return `Approved, but it could not be completed: ${r.error}`;
    return r.status === "approved" ? "Approved and done." : "Rejected. The requester was told.";
  });
}

const left = (d: Date) => { const h = Math.max(0, Math.round((d.getTime() - Date.now()) / 3_600_000)); return h >= 24 ? `${Math.round(h / 24)} d left` : `${h} h left`; };

export default async function Approvals({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["seller", "buyer", "financier"]);
  const q = await searchParams;
  const rows = u.businessId ? await listRequests(db, u.businessId) : [];
  const decider = can(u, "approval.decide");
  const toDecide = rows.filter((x) => x.r.status === "pending" && x.r.requestedBy !== u.id);
  const mine = rows.filter((x) => x.r.requestedBy === u.id);
  const history = rows.filter((x) => x.r.status !== "pending" && x.r.requestedBy !== u.id).slice(0, 20);
  return (
    <>
      <PageHead title="Approvals" sub="Anything that commits company money is prepared by one person and decided by another. Nobody decides their own request." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}

      {decider && (
        <Panel title={`Waiting for your decision (${toDecide.length})`} className="mb-5" flush>
          {toDecide.length === 0 ? <div className="p-5"><EmptyState icon="check" title="Nothing waiting">Requests from your team appear here.</EmptyState></div> : (
            <DataTable rows={toDecide} rowKey={(x) => x.r.id}
              cols={[
                { h: "Request", cell: (x) => <>{x.r.summary}<span className="block text-xs font-normal text-muted">{KIND[x.r.kind] ?? x.r.kind} · asked by {x.by}</span></> },
                { h: "Amount", align: "right", cell: (x) => (x.r.amount > 0n ? formatMoney(x.r.amount) : <span className="text-faint">-</span>) },
                { h: "Time", cell: (x) => <span className="font-normal text-muted">{left(x.r.expiresAt)}</span> },
                { h: "", align: "right", cell: (x) => (
                  <form action={act} className="flex flex-wrap items-center justify-end gap-2">
                    <input type="hidden" name="id" value={x.r.id} />
                    <input name="note" placeholder="Note (optional)" className="field-inline !py-1.5 w-40 text-sm" />
                    <button name="action" value="approve" className="btn btn-primary btn-sm">Approve</button>
                    <button name="action" value="reject" className="btn btn-ghost btn-sm">Reject</button>
                  </form>
                ) },
              ]} />
          )}
        </Panel>
      )}

      <Panel title="Your requests" className="mb-5" flush>
        <DataTable rows={mine} rowKey={(x) => x.r.id} empty="You have not asked for anything to be approved."
          cols={[
            { h: "Request", cell: (x) => <>{x.r.summary}<span className="block text-xs font-normal text-muted">{KIND[x.r.kind] ?? x.r.kind}</span></> },
            { h: "Amount", align: "right", cell: (x) => (x.r.amount > 0n ? formatMoney(x.r.amount) : <span className="text-faint">-</span>) },
            { h: "Status", cell: (x) => <>
              <StatusPill status={x.r.status === "approved" ? "approved" : x.r.status === "pending" ? "pending" : "rejected"} label={x.r.status} />
              {x.r.note && <span className="block text-xs font-normal text-muted">{x.r.note}</span>}</> },
            { h: "", align: "right", cell: (x) => x.r.status === "pending" && (
              <form action={act}><input type="hidden" name="id" value={x.r.id} /><button name="action" value="cancel" className="btn btn-ghost btn-sm">Withdraw</button></form>
            ) },
          ]} />
      </Panel>

      {history.length > 0 && (
        <Panel title="Earlier decisions" flush>
          <DataTable rows={history} rowKey={(x) => x.r.id}
            cols={[
              { h: "Request", cell: (x) => <>{x.r.summary}<span className="block text-xs font-normal text-muted">asked by {x.by}</span></> },
              { h: "Amount", align: "right", cell: (x) => (x.r.amount > 0n ? formatMoney(x.r.amount) : "-") },
              { h: "Outcome", cell: (x) => <StatusPill status={x.r.status === "approved" ? "approved" : "rejected"} label={x.r.status} /> },
              { h: "Decided", cell: (x) => <span className="font-normal text-muted">{x.r.decidedAt?.toLocaleDateString("en-IN") ?? "-"}</span> },
            ]} />
        </Panel>
      )}
    </>
  );
}
