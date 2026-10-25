import { currentDocuments } from "@/server/kyb/documents";
import { db } from "@/server/db/client";
import { Card } from "@/components/ui/cards";
import { Icon } from "@/components/ui/icons";
import { market } from "@/lib/countries";
import { uploadDocument } from "./actions";

const input = "field font-normal";
const FIELD_LABEL: Record<string, string> = {
  taxId: "Tax number", legalName: "Name", tradeName: "Trade name", registeredOn: "Registered on", companyReg: "Registration number", incorporatedOn: "Incorporated on",
  udyam: "Udyam number", enterpriseType: "Type", bankAccount: "Account", bankCode: "Bank code", holderName: "Account holder",
};

/** The documents this country asks for, with what we read from each and anything we noticed. Staff see the same. */
export async function Documents({ businessId, error }: { businessId: string; error?: string }) {
  const docs = new Map((await currentDocuments(db, businessId)).map((d) => [d.kind, d]));
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card title="Documents">
      <p className="mb-4 text-sm text-muted">Upload a clear PDF, PNG or JPG of each document (up to 4 MB). We read it to save typing and to spot differences from what you declared; a person reviews everything.</p>
      {error && <p role="alert" className="mb-4 rounded-lg bg-r-100 px-3.5 py-3 text-sm text-r-600">{error}</p>}
      <ul className="space-y-4">
        {market().documents.map((s) => {
          const d = docs.get(s.kind);
          const expired = d?.validUntil && d.validUntil < today;
          return (
            <li key={s.kind} className="rounded-lg bg-panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <b className="text-sm">{s.label}</b>
                <span className={`pill ${s.required ? "bg-s-100 text-s-600" : "bg-card text-muted"}`}>{s.required ? "Required" : "Optional"}</span>
                {d && !expired && <span className="pill bg-g-100 text-g-600"><Icon name="check" className="h-3 w-3" />Uploaded</span>}
                {expired && <span className="pill bg-r-100 text-r-600">Expired</span>}
              </div>
              {d && (
                <div className="mt-2 text-[13px] text-muted">
                  <p>{d.filename}{d.validUntil ? ` · valid until ${d.validUntil}` : ""}</p>
                  {d.reading === "unreadable" && <p>We could not read this file. A person will look at it.</p>}
                  {!!d.extracted && Object.keys(d.extracted as object).length > 0 && (
                    <p className="mt-1">Read from it: {Object.entries(d.extracted as Record<string, string>).map(([k, v]) => `${FIELD_LABEL[k] ?? k}: ${v}`).join(" · ")}</p>
                  )}
                  {d.flags.map((f) => <p key={f} className="mt-1 text-s-600"><Icon name="alert" className="mr-1 inline h-3.5 w-3.5" />{f}</p>)}
                </div>
              )}
              <form action={uploadDocument} className="mt-3 flex flex-wrap items-end gap-3">
                <input type="hidden" name="kind" value={s.kind} />
                <label className="block min-w-0 flex-1 text-xs font-medium">{d ? "Replace with a newer file" : "Choose a file"}
                  <input name="file" type="file" required accept="application/pdf,image/png,image/jpeg" className={`${input} mt-1 !py-2 text-sm`} /></label>
                {s.expires && <label className="block text-xs font-medium">Valid until<input name="validUntil" type="date" required className={`${input} mt-1 !py-2 text-sm`} /></label>}
                <button className="btn btn-ghost btn-sm">{d ? "Replace" : "Upload"}</button>
              </form>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
