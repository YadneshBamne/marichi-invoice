import Link from "next/link";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { ML, VERSION } from "@/server/underwriting/ml";
import { modelReport } from "@/server/underwriting/ml-report";
import { DataTable, Notice, PageHead, Panel } from "@/components/ui/page";
import { Stat } from "@/components/ui/cards";
import { formatINR } from "@/lib/money";

export const metadata = { title: "Model monitor" };
const MODE = ["Off", "Shadow", "Assist"];
const GRADES = ["A", "B", "C", "D", "E"];

export default async function Models() {
  const u = await requireUser(["ops", "compliance", "admin"]);
  const r = await modelReport(db);
  const outcomeRows = (label: string, rows: typeof r.rulesOutcomes) => rows.map((x) => ({ ...x, label }));
  return (
    <>
      <PageHead title="Model monitor" sub="A scoring model runs beside the underwriting rules on every decision. This page shows where they agree, where they differ, and which predicted the outcome better as invoices settle." />
      <div className="mb-5"><Notice tone="warn">Version <b>{VERSION}</b> uses expert-set weights, not weights trained on repayment history, because there is no history to train on yet. Treat its verdicts as a second opinion, not as evidence. The mode is <b>{MODE[ML.mode]}</b>{ML.mode === 1 && ": it records its view and never changes a decision"}{ML.mode === 2 && ": it may send an approval to a person when it rates it two or more grades worse, and can never loosen a rule"}.{u.role === "admin" && <> Change it in <Link className="font-semibold underline" href="/admin/policy">Policy</Link>.</>}</Notice></div>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Stat hero label="Decisions scored" value={String(r.total)} note="rules and model side by side" />
        <Stat label="Same grade" value={r.agreementPct === null ? "n/a" : `${r.agreementPct}%`} note={`${r.agree} of ${r.total}`} />
        <Stat label="Settled so far" value={String(r.settled)} note={r.settled < 30 ? "too few to compare accuracy yet" : "enough to start comparing"} />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Rules grade against model grade" sub="Rows are the rules, columns are the model" flush>
          <DataTable rows={GRADES} rowKey={(g) => g} cols={[
            { h: "Rules \ Model", cell: (g) => `Grade ${g}` },
            ...GRADES.map((m) => ({ h: m, align: "center" as const, cell: (g: string) => <span className={g === m ? "font-semibold" : r.matrix[g][m] ? "" : "text-faint"}>{r.matrix[g][m]}</span> })),
          ]} />
        </Panel>
        <Panel title="Outcomes by grade" sub="Which grading separated good from bad invoices" flush>
          <DataTable rows={[...outcomeRows("Rules", r.rulesOutcomes), ...outcomeRows("Model", r.modelOutcomes)].filter((x) => x.invoices > 0)} rowKey={(x) => `${x.label}${x.grade}`} empty="No scored invoices yet."
            cols={[
              { h: "By", cell: (x) => x.label }, { h: "Grade", cell: (x) => x.grade },
              { h: "Invoices", align: "right", cell: (x) => x.invoices }, { h: "Paid", align: "right", cell: (x) => x.paid },
              { h: "Overdue or lost", align: "right", cell: (x) => <span className={x.bad ? "font-semibold text-r-600" : ""}>{x.bad}</span> }, { h: "Open", align: "right", cell: (x) => x.open },
            ]} />
        </Panel>
      </div>
      <Panel title="Big disagreements" sub="The model and the rules differ by two or more grades" flush className="mt-5">
        <DataTable rows={r.disagreements} rowKey={(d) => d.m.invoiceId} empty="No large disagreements."
          cols={[
            { h: "Invoice", cell: (d) => d.number }, { h: "Amount", align: "right", cell: (d) => formatINR(d.amount) },
            { h: "Rules", align: "center", cell: (d) => d.m.rulesGrade }, { h: "Model", align: "center", cell: (d) => d.m.grade },
            { h: "Model's main reasons", cell: (d) => <span className="font-normal text-muted">{(d.m.reasons as { text: string }[]).slice(0, 2).map((x) => x.text).join(" · ")}</span> },
          ]} />
      </Panel>
    </>
  );
}
