"use client";
import { useRef, useState, useTransition } from "react";
import { Icon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/forms";
import { readInvoice, type Reading } from "./read-action";
import { market } from "@/lib/countries";

type Buyer = { id: string; name: string };
const input = "field font-normal";
const EMPTY = { buyerId: "", invoiceNumber: "", amount: "", invoiceDate: "", dueDate: "", irn: "", poReference: "" };
type Values = typeof EMPTY;

/** The upload form. Choosing a file reads it and pre-fills what it can; the seller checks everything and submits. */
export function UploadForm({ buyers, action }: { buyers: Buyer[]; action: (fd: FormData) => Promise<void> }) {
  const [v, setV] = useState<Values>({ ...EMPTY, buyerId: buyers[0]?.id ?? "" });
  const [status, setStatus] = useState<{ tone: "info" | "good" | "bad"; text: string; notes?: string[] } | null>(null);
  const [pending, start] = useTransition();
  const typed = useRef(new Set<string>()); // fields the seller has edited by hand: a reading never overwrites those
  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { typed.current.add(k); setV((x) => ({ ...x, [k]: e.target.value })); };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { setStatus({ tone: "bad", text: "That file is over 4 MB. Choose a smaller one." }); e.target.value = ""; return; }
    setStatus({ tone: "info", text: "Reading your invoice…" });
    const fd = new FormData(); fd.set("file", file);
    start(async () => {
      let r: Reading;
      try { r = await readInvoice(fd); } catch { r = { ok: false, error: "The invoice could not be read." }; }
      if (!r.ok) return setStatus({ tone: "bad", text: `${r.error} You can still fill the form in by hand.` });
      setV((x) => { const n = { ...x }; for (const [k, val] of Object.entries(r.values)) if (!typed.current.has(k) && val) (n as Record<string, string>)[k] = val; return n; });
      const count = r.found.filter((k) => k !== "buyerId").length;
      setStatus({
        tone: count ? "good" : "info",
        text: count
          ? `${r.simulated ? "Sandbox reading: these values are simulated. " : ""}We filled ${count} field${count === 1 ? "" : "s"} from the invoice. Please check each one before submitting.`
          : "We couldn't read any details from this file. Please fill the form in.",
        notes: r.notes,
      });
    });
  };

  const tone = { info: "bg-i-100 text-i-500", good: "bg-g-100 text-g-600", bad: "bg-r-100 text-r-600" };
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <label className="block text-sm font-medium sm:col-span-2">Invoice file <span className="font-normal text-faint">(PDF, PNG or JPG, up to 4 MB)</span>
        <input name="file" type="file" accept="application/pdf,image/png,image/jpeg" required onChange={onFile} className={`${input} mt-1 file:mr-3 file:rounded-full file:border-0 file:bg-p-100 file:px-4 file:py-1.5 file:font-semibold file:text-p-700`} />
        <span className="mt-1 block text-xs font-normal text-muted">Choose the file first and we will read the details for you.</span>
      </label>
      {status && (
        <div className={`anim-pop flex items-start gap-2.5 rounded-lg px-3.5 py-3 text-sm sm:col-span-2 ${tone[status.tone]}`} role="status">
          {pending ? <Spinner className="mt-0.5 h-4 w-4" /> : <Icon name={status.tone === "bad" ? "alert" : "check"} className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{status.text}{status.notes?.map((n) => <span key={n} className="mt-1 block">{n}</span>)}</span>
        </div>
      )}
      <label className="block text-sm font-medium sm:col-span-2">Buyer
        <select name="buyerId" value={v.buyerId} onChange={set("buyerId")} className={`${input} mt-1`}>{buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <label className="block text-sm font-medium">Invoice number<input name="invoiceNumber" required value={v.invoiceNumber} onChange={set("invoiceNumber")} className={`${input} mt-1`} /></label>
      <label className="block text-sm font-medium">Amount ({market().currency.symbol}, incl. tax)<input name="amount" inputMode="decimal" required value={v.amount} onChange={set("amount")} className={`${input} mt-1`} /></label>
      <label className="block text-sm font-medium">Invoice date<input name="invoiceDate" type="date" required value={v.invoiceDate} onChange={set("invoiceDate")} className={`${input} mt-1`} /></label>
      <label className="block text-sm font-medium">Due date<input name="dueDate" type="date" required value={v.dueDate} onChange={set("dueDate")} className={`${input} mt-1`} /></label>
      <label className="block text-sm font-medium">e-Invoice {market().eInvoice.short} (if issued)<input name="irn" value={v.irn} onChange={set("irn")} className={`${input} mt-1`} /></label>
      <label className="block text-sm font-medium">PO reference<input name="poReference" value={v.poReference} onChange={set("poReference")} className={`${input} mt-1`} /></label>
      <div className="sm:col-span-2"><button className="btn btn-primary" disabled={pending}>Submit invoice</button></div>
    </form>
  );
}
