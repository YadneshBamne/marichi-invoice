import { desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { businesses, financingOffers, invoices, registryFilings } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { fileAssignment } from "@/server/registry/service";
import { market, PACKS } from "@/lib/countries";
import { formatMoney } from "@/lib/money";
import { DataTable, KV, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { revalidatePath } from "next/cache";

export const metadata = { title: "Market and registry" };

async function retry(fd: FormData) {
  "use server";
  await requireUser(["ops", "admin"]);
  await fileAssignment(db, String(fd.get("id")));
  revalidatePath("/admin/market");
}

export default async function Market() {
  await requireUser(["ops", "compliance", "admin"]);
  const m = market();
  const filings = await db.select({ f: registryFilings, number: invoices.invoiceNumber, seller: businesses.legalName, advance: financingOffers.advanceAmount })
    .from(registryFilings)
    .innerJoin(financingOffers, eq(financingOffers.id, registryFilings.offerId))
    .innerJoin(invoices, eq(invoices.id, registryFilings.invoiceId))
    .innerJoin(businesses, eq(businesses.id, invoices.sellerId))
    .orderBy(desc(registryFilings.createdAt)).limit(50);
  const reg = m.registry;
  const ids = [...new Set([m.ids.kyb, m.ids.taxReg, ...(m.ids.companyReg ? [m.ids.companyReg] : []), m.ids.bankCode].map((i) => i.label))].join(", ");
  return (
    <>
      <PageHead title="Market and registry" sub={`This deployment serves ${m.name}. Everything below comes from its country pack, and every legal statement in it is a draft for local counsel.`} />
      <div className="mb-5"><Notice tone="warn">One deployment serves one home market: its law, licence, partner bank, currency and data region. To open another country, deploy another copy with NEXT_PUBLIC_MARKET set to that country.</Notice></div>
      <div className="mb-5 grid gap-5 xl:grid-cols-2">
        <Panel title="How this market works">
          <KV rows={[
            ["Currency", `${m.currency.code} (${m.currency.major}, ${m.currency.minor}), shown as ${formatMoney(123_456_789n)}`],
            ["Identifiers asked for", ids],
            [`Tax on our fees`, `${m.tax.name} at ${m.tax.rateBps / 100}%`],
            ["E-invoice check", `${m.eInvoice.short}, with ${m.eInvoice.authority}`],
            ["Payout rails", `${m.rails.small.join(" then ")} up to ${formatMoney(m.rails.largeAbove)}; ${m.rails.large.join(" then ")} above`],
            ["Recurring debit scheme", m.mandate],
            ["Platform lends from its own balance sheet", m.platformFunds ? "Yes, where our licence allows (a policy switch)" : "No: financiers fund, until a licence says otherwise"],
          ]} />
        </Panel>
        <Panel title="Law, data and complaints">
          <KV rows={[
            ["Governing law", m.terms.law], ["Forum", m.terms.forum], ["Electronic signature", m.terms.esign],
            ["Registry for assignments", reg ? `${reg.short}: ${reg.when === "before_payout" ? "filed before any money moves" : `filed within ${reg.withinDays} days of assignment`}` : "None"],
            ["Data protection", m.privacy.law], ["Regulator", m.privacy.regulator],
            ["Breach notice clock", `${m.privacy.breachHours} hours`], ["Where data may live", m.privacy.residency],
            ["Complaints", `${m.ombudsman.name}`],
          ]} />
        </Panel>
      </div>
      <Panel title="Registry filings" sub={reg ? `Each financed invoice is filed at ${reg.short}. ${reg.when === "before_payout" ? "A payout waits until its filing is done." : "India allows filing after the assignment, within the deadline shown."}` : "This market has no registry to file at."} flush>
        <DataTable rows={filings} rowKey={(r) => r.f.id} empty="Nothing to file yet."
          cols={[
            { h: "Invoice", cell: (r) => r.number },
            { h: "Seller", cell: (r) => <span className="font-normal text-muted">{r.seller}</span> },
            { h: "Advance", align: "right", cell: (r) => formatMoney(r.advance) },
            { h: "Registry", cell: (r) => r.f.registry },
            { h: "Status", cell: (r) => <StatusPill status={r.f.status === "filed" ? "approved" : "pending"} label={r.f.status} /> },
            { h: "Reference", cell: (r) => <span className="font-mono text-xs font-normal">{r.f.reference ?? r.f.lastError ?? "-"}</span> },
            { h: "Due by", cell: (r) => <span className="font-normal text-muted">{r.f.dueBy ?? "-"}</span> },
            { h: "", align: "right", cell: (r) => r.f.status === "pending" && <form action={retry}><input type="hidden" name="id" value={r.f.id} /><button className="btn btn-ghost btn-sm">File now</button></form> },
          ]} />
      </Panel>
      <Panel title="Country packs built" className="mt-5" flush>
        <DataTable rows={Object.values(PACKS)} rowKey={(p) => p.code}
          cols={[
            { h: "Country", cell: (p) => <>{p.name}{p.code === m.code && <span className="pill ml-2 bg-g-100 text-g-600">this deployment</span>}</> },
            { h: "Currency", cell: (p) => p.currency.code },
            { h: "Tax ids", cell: (p) => <span className="font-normal text-muted">{[...new Set([p.ids.kyb.label, p.ids.taxReg.label])].join(", ")}</span> },
            { h: "Registry", cell: (p) => <span className="font-normal text-muted">{p.registry?.short ?? "-"}</span> },
            { h: "Own balance sheet", cell: (p) => <span className="font-normal text-muted">{p.platformFunds ? "allowed" : "off"}</span> },
          ]} />
      </Panel>
    </>
  );
}
