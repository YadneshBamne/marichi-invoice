import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { can } from "@/server/permissions";
import { GRADES, listLimits, mandateOf, profileOf, saveMandate, setBuyerLimit } from "@/server/marketplace/financier";
import { DataTable, EmptyState, Field, Notice, PageHead, Panel, Pop, StatusPill } from "@/components/ui/page";
import { formatINR, rupeesToPaise, toDecimal } from "@/lib/money";
import { attempt } from "../attempt";

export const metadata = { title: "Mandate and limits" };
const PATH = "/financier/mandate";
const input = "field font-normal";
const blank = (v: FormDataEntryValue | null) => (String(v ?? "").trim() === "" ? null : String(v).trim());

async function actorOf() {
  const u = await requireUser(["financier"]);
  return { id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId };
}

async function saveRules(fd: FormData) {
  "use server";
  const a = await actorOf();
  await attempt(PATH, async () => {
    const maxTicket = blank(fd.get("maxTicket")), perSeller = blank(fd.get("maxPerSeller"));
    const auto = fd.get("autoBid") === "on";
    await saveMandate(db, a, {
      status: fd.get("status") === "paused" ? "paused" : "active",
      minTicket: rupeesToPaise(String(fd.get("minTicket") || "0")), maxTicket: maxTicket ? rupeesToPaise(maxTicket) : null,
      minTenorDays: Number(fd.get("minTenorDays") || 1), maxTenorDays: Number(fd.get("maxTenorDays") || 365),
      minGrade: String(fd.get("minGrade") || "C"), maxPerSeller: perSeller ? rupeesToPaise(perSeller) : null,
      sectors: String(fd.get("sectors") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      autoBid: auto, autoDiscountBps: auto ? Math.round(Number(fd.get("autoDiscountPct")) * 100) : null, autoAdvanceBps: auto && blank(fd.get("autoAdvancePct")) ? Math.round(Number(fd.get("autoAdvancePct")) * 100) : null,
    });
    return "Mandate saved. Every bid, yours and automatic, is checked against it.";
  });
}

async function saveLimit(fd: FormData) {
  "use server";
  const a = await actorOf();
  await attempt(PATH, async () => {
    const f = z.object({ gstin: z.string().trim().toUpperCase().min(10), limit: z.string(), status: z.enum(["active", "blocked"]) }).parse(Object.fromEntries(fd));
    const [b] = await db.select({ id: businesses.id }).from(businesses).where(and(eq(businesses.gstin, f.gstin), or(eq(businesses.kind, "buyer"), sql`${businesses.kind} is null`)));
    if (!b) throw new Error("we do not know a buyer with that GSTIN. It appears once a supplier has named it");
    await setBuyerLimit(db, a, { buyerId: b.id, limit: rupeesToPaise(f.limit), status: f.status });
    return f.status === "blocked" ? "Buyer blocked." : "Limit saved.";
  });
}

export default async function Mandate({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["financier"]);
  const q = await searchParams;
  const [p, m, limits] = await Promise.all([profileOf(db, u.businessId!), mandateOf(db, u.businessId!), listLimits(db, u.businessId!)]);
  const may = can(u, "mandate.manage");
  if (!p || p.status !== "approved") return (
    <>
      <PageHead title="Mandate and limits" sub="What you are willing to fund, and how much you will lend to each buyer." />
      <EmptyState icon="shield" title="Complete your application first">Your mandate opens once our team has approved your licence. <a className="font-semibold text-p-700 underline" href="/financier/application">Go to your application</a>.</EmptyState>
    </>
  );
  return (
    <>
      <PageHead title="Mandate and limits" sub="Every bid, yours or automatic, is checked against this. You can only bid on a buyer you have given a limit." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      {!may && <div className="mb-4"><Notice tone="warn">Only an owner or approver can change your mandate and limits.</Notice></div>}

      <div className="grid gap-5 xl:grid-cols-[1.1fr_1fr]">
        <Panel title="What you will fund">
          <form action={saveRules} className="grid gap-4 sm:grid-cols-2">
            <Field label="Status"><select name="status" defaultValue={m?.status ?? "active"} disabled={!may} className={input}><option value="active">Active</option><option value="paused">Paused: no new bids</option></select></Field>
            <Field label="Worst grade you accept" hint="A is best, E is worst."><select name="minGrade" defaultValue={m?.minGrade ?? "C"} disabled={!may} className={input}>{GRADES.map((g) => <option key={g}>{g}</option>)}</select></Field>
            <Field label="Smallest ticket (₹)"><input name="minTicket" inputMode="decimal" defaultValue={m ? toDecimal(m.minTicket) : "0"} disabled={!may} className={input} /></Field>
            <Field label="Largest ticket (₹)" hint="Blank means no cap."><input name="maxTicket" inputMode="decimal" defaultValue={m?.maxTicket != null ? toDecimal(m.maxTicket) : ""} disabled={!may} className={input} /></Field>
            <Field label="Shortest tenor (days)"><input name="minTenorDays" type="number" min={1} defaultValue={m?.minTenorDays ?? 1} disabled={!may} className={input} /></Field>
            <Field label="Longest tenor (days)"><input name="maxTenorDays" type="number" min={1} defaultValue={m?.maxTenorDays ?? 365} disabled={!may} className={input} /></Field>
            <Field label="Most you will have out to one seller (₹)" hint="Blank means no cap."><input name="maxPerSeller" inputMode="decimal" defaultValue={m?.maxPerSeller != null ? toDecimal(m.maxPerSeller) : ""} disabled={!may} className={input} /></Field>
            <Field label="Industries" hint="Comma-separated, blank for any."><input name="sectors" defaultValue={m?.sectors.join(", ") ?? ""} disabled={!may} className={input} /></Field>
            <fieldset className="rounded-xl bg-panel p-4 sm:col-span-2">
              <label className="flex items-start gap-3 text-sm"><input type="checkbox" name="autoBid" defaultChecked={m?.autoBid} disabled={!may} className="mt-1" /><span><b>Bid automatically</b><span className="mt-0.5 block text-xs text-muted">We bid on every open deal that fits this mandate and a buyer limit, at the rate below. You can still bid by hand, and withdraw any bid.</span></span></label>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Discount to bid (% a year)"><input name="autoDiscountPct" type="number" step="0.01" defaultValue={m?.autoDiscountBps ? m.autoDiscountBps / 100 : ""} disabled={!may} className={input} /></Field>
                <Field label="Advance to bid (% of invoice)" hint="Blank means the most the grade allows."><input name="autoAdvancePct" type="number" step="0.01" defaultValue={m?.autoAdvanceBps ? m.autoAdvanceBps / 100 : ""} disabled={!may} className={input} /></Field>
              </div>
            </fieldset>
            {may && <div className="sm:col-span-2"><button className="btn btn-primary">Save mandate</button></div>}
          </form>
        </Panel>

        <Panel title={`Limits on buyers (${limits.length})`} sub="The most you will have out to each buyer at once." flush
          action={may ? (
            <Pop id="new-limit" label="Set a limit" cls="btn btn-primary btn-sm">
              <form action={saveLimit} className="space-y-2">
                <input name="gstin" required placeholder="Buyer GSTIN" className="field !py-2 text-sm uppercase" />
                <input name="limit" inputMode="decimal" required placeholder="Limit (₹)" className="field !py-2 text-sm" />
                <select name="status" className="field !py-2 text-sm"><option value="active">Active</option><option value="blocked">Blocked</option></select>
                <button className="btn btn-primary btn-sm w-full">Save limit</button>
              </form>
            </Pop>
          ) : undefined}>
          <DataTable rows={limits} rowKey={(l) => l.buyerId} empty="No limits yet. Set one for each buyer you are willing to fund."
            cols={[
              { h: "Buyer", cell: (l) => <>{l.name}<span className="block font-mono text-xs font-normal text-muted">{l.gstin}</span></> },
              { h: "Limit", align: "right", cell: (l) => formatINR(l.limit) },
              { h: "Out now", align: "right", cell: (l) => formatINR(l.used) },
              { h: "Left", align: "right", cell: (l) => formatINR(l.left) },
              { h: "Status", cell: (l) => <StatusPill status={l.status === "active" ? "approved" : "rejected"} label={l.status} /> },
            ]} />
        </Panel>
      </div>
    </>
  );
}
