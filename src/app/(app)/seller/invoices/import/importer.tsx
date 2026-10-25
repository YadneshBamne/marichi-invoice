"use client";
import { useState, useTransition } from "react";
import { Alert, Spinner } from "@/components/ui/forms";
import { DataTable, Panel, StatusPill } from "@/components/ui/page";
import { runImport, type ImportOutcome } from "./actions";
import { market } from "@/lib/countries";

const TEMPLATE = "invoice_number,buyer_gstin,invoice_date,due_date,amount,irn,po_reference\nINV-1001,29BBBBB2222B1Z5,01-10-2026,30-11-2026,118000.00,,PO-5521\n";

export function Importer() {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [out, setOut] = useState<ImportOutcome | null>(null);
  const [pending, start] = useTransition();

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setOut(null);
    if (!f) return;
    setName(f.name); setText(await f.text());
  };
  const go = (dryRun: boolean) => start(async () => setOut(await runImport(text, dryRun)));

  return (
    <div className="space-y-5">
      <Panel title="1. Choose your file" sub="A CSV with a header row. Common column names from Tally, Zoho Books and Excel are understood.">
        <div className="space-y-3 text-sm">
          <input type="file" accept=".csv,text/csv" onChange={pick} className="field font-normal file:mr-3 file:rounded-full file:border-0 file:bg-p-100 file:px-4 file:py-1.5 file:font-semibold file:text-p-700" />
          <p className="text-muted">Needed columns: invoice number, buyer {market().ids.taxReg.label}, invoice date, due date, amount. Optional: {market().eInvoice.short}, PO reference. Up to 200 invoices at a time. Buyers must already be linked under Buyers.
            {" "}<a className="font-semibold text-p-700 underline" download="invoices-template.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`}>Download a template</a></p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" disabled={!text || pending} onClick={() => go(true)}>{pending && <Spinner />}Check the file</button>
            <button className="btn btn-primary" disabled={!text || pending} onClick={() => go(false)}>Import valid rows</button>
          </div>
          {name && <p className="text-xs text-faint">{name}</p>}
        </div>
      </Panel>

      {out && !out.ok && <Alert>{out.error}</Alert>}
      {out?.ok && (
        <Panel title={out.dryRun ? "Check result: nothing was saved" : "Import result"} sub={out.dryRun ? `${out.valid} ready to import, ${out.invalid} with a problem` : `${out.imported} imported, ${out.invalid} skipped. Your buyers have been asked to confirm the imported invoices.`} flush>
          <DataTable rows={out.results} rowKey={(r) => `${r.line}-${r.number}`}
            cols={[
              { h: "Line", align: "right", cell: (r) => r.line },
              { h: "Invoice", cell: (r) => r.number || "-" },
              { h: "Result", cell: (r) => <StatusPill status={r.ok ? "approved" : "rejected"} label={r.ok ? (out.dryRun ? "ready" : "imported") : "problem"} /> },
              { h: "Detail", cell: (r) => <span className="font-normal text-muted">{r.error ?? ""}</span> },
            ]} />
        </Panel>
      )}
    </div>
  );
}
