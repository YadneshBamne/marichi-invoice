import { z } from "zod";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/server/db/client";
import { businesses } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { INSTITUTIONS, listLimits, mandateOf, profileOf, reviewApplication, type Review } from "@/server/marketplace/financier";
import { position } from "@/server/marketplace/service";
import { KV, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { formatINR } from "@/lib/money";
import { attempt } from "../../../financier/attempt";

export const metadata = { title: "Financier review" };

async function decide(fd: FormData) {
  "use server";
  const u = await requireUser(["ops", "compliance", "admin"]);
  const f = z.object({ id: z.uuid(), decision: z.enum(["approve", "reject", "request_info", "suspend", "reinstate"]), note: z.string().max(500).optional() }).parse(Object.fromEntries(fd));
  await attempt(`/admin/financiers/${f.id}`, async () => {
    await reviewApplication(db, u, f.id, f.decision as Review, f.note ?? "");
    return "Recorded. The financier has been told.";
  });
}

export default async function Review({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireUser(["ops", "compliance", "admin"]);
  const { id } = await params;
  const q = await searchParams;
  const [b] = await db.select().from(businesses).where(eq(businesses.id, id));
  if (!b) notFound();
  const [p, m, limits, pos] = await Promise.all([profileOf(db, id), mandateOf(db, id), listLimits(db, id), position(db, id)]);
  const expired = p?.licenceValidUntil && p.licenceValidUntil < new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageHead back={{ href: "/admin/financiers", label: "Financiers" }} title={b.displayName ?? b.legalName} sub="Check the licence against the regulator's own register before approving." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      {!p ? <Notice tone="warn">This company has not started an application.</Notice> : (
        <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
          <div className="space-y-5">
            <Panel title="Application" action={<StatusPill status={p.status === "approved" ? "approved" : p.status === "submitted" ? "pending" : "rejected"} label={p.status.replaceAll("_", " ")} />}>
              <KV rows={[
                ["Company verification (KYB)", <StatusPill key="k" status={b.kybStatus === "approved" ? "approved" : "pending"} label={b.kybStatus.replaceAll("_", " ")} />],
                ["Institution", INSTITUTIONS[p.institutionType as keyof typeof INSTITUTIONS] ?? p.institutionType],
                ["Licensed in", p.countries.join(", ")],
                ["Regulator", p.regulator],
                ["Licence", `${p.licenceType}, ${p.licenceNumber}`],
                ["Valid until", <span key="v" className={expired ? "text-r-600" : ""}>{p.licenceValidUntil ?? "no expiry stated"}{expired ? " (expired)" : ""}</span>],
                ["Licence copy", p.licenceDocRef ? <a key="d" className="font-semibold text-p-700 underline" href={`/api/documents/${p.licenceDocRef}`} target="_blank">Open the copy</a> : "none"],
                ["Settlement account", `${p.settlementName}, ${p.settlementIfsc}, ending ${p.settlementAccount?.slice(-4)} ${p.settlementVerified ? "(name matched)" : "(name did NOT match)"}`],
                ["Sent", p.submittedAt?.toLocaleString("en-IN") ?? "not sent"],
                ["Reviewer note", p.note ?? "-"],
              ]} />
            </Panel>
            {m && <Panel title="Mandate"><KV rows={[
              ["Status", m.status], ["Worst grade", m.minGrade], ["Ticket", `${formatINR(m.minTicket)} to ${m.maxTicket != null ? formatINR(m.maxTicket) : "no cap"}`],
              ["Tenor", `${m.minTenorDays} to ${m.maxTenorDays} days`], ["Automatic bids", m.autoBid ? `on, ${(m.autoDiscountBps ?? 0) / 100}% a year` : "off"],
            ]} /></Panel>}
          </div>
          <div className="space-y-5">
            <Panel title="Decision">
              <form action={decide} className="space-y-3">
                <input type="hidden" name="id" value={id} />
                <textarea name="note" rows={3} placeholder="Note (required unless approving)" className="field text-sm font-normal" />
                <div className="flex flex-wrap gap-2">
                  {p.status === "submitted" && <><button name="decision" value="approve" className="btn btn-primary btn-sm">Approve</button><button name="decision" value="request_info" className="btn btn-ghost btn-sm">Ask for more</button></>}
                  {["submitted", "info_requested"].includes(p.status) && <button name="decision" value="reject" className="btn btn-danger btn-sm">Reject</button>}
                  {p.status === "approved" && <button name="decision" value="suspend" className="btn btn-danger btn-sm">Suspend</button>}
                  {p.status === "suspended" && <button name="decision" value="reinstate" className="btn btn-primary btn-sm">Reinstate</button>}
                </div>
                <p className="text-xs text-muted">Approval creates a default mandate (grade C or better, no caps, no automatic bidding) for the financier to adjust. Suspending stops new bids, payouts on accepted bids, and funding.</p>
              </form>
            </Panel>
            <Panel title="Funds and limits"><KV rows={[["In escrow", formatINR(pos.funds)], ["Promised to deals", formatINR(pos.reserved)], ["Deployed", formatINR(pos.deployed)], ["Buyer limits set", String(limits.length)]]} /></Panel>
          </div>
        </div>
      )}
    </>
  );
}
