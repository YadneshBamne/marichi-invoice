import { db } from "@/server/db/client";
import { accountingFor, connectionOf, PROVIDERS, type Provider } from "@/server/erp/connections";
import { Panel, StatusPill } from "@/components/ui/page";
import { disconnectErp, syncErp } from "./erp-actions";

const when = (d: Date | null) => (d ? d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never");

/** Connect Zoho Books or QuickBooks and import its unpaid invoices. Only providers this platform has keys for are shown. */
export async function AccountingPanel({ businessId, owner }: { businessId: string; owner: boolean }) {
  const shown = (Object.keys(PROVIDERS) as Provider[]).filter((p) => accountingFor(p));
  if (!shown.length) return null;
  const rows = await Promise.all(shown.map(async (p) => ({ p, conn: await connectionOf(db, businessId, p) })));
  return (
    <Panel title="Accounting systems" sub="Connect your accounting software and import its unpaid invoices. Each goes through the same checks as an upload, and your buyer is asked to confirm it.">
      <ul className="divide-y divide-hair text-sm">
        {rows.map(({ p, conn }) => (
          <li key={p} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div>
              <p className="font-semibold">{PROVIDERS[p]}</p>
              {conn
                ? <p className="text-xs text-muted">Connected {when(conn.createdAt)}. Last import: {conn.lastSyncAt ? `${when(conn.lastSyncAt)}, ${conn.lastSyncNote}` : "none yet"}{conn.status === "expired" && conn.lastSyncNote ? `. ${conn.lastSyncNote}` : ""}</p>
                : <p className="text-xs text-muted">Not connected.</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {conn && <StatusPill status={conn.status === "active" ? "approved" : "rejected"} label={conn.status === "active" ? "connected" : "reconnect needed"} />}
              {conn?.status === "active" && (
                <>
                  <form action={syncErp}><input type="hidden" name="provider" value={p} /><button name="mode" value="check" className="btn btn-ghost btn-sm">Check</button></form>
                  <form action={syncErp}><input type="hidden" name="provider" value={p} /><button name="mode" value="import" className="btn btn-primary btn-sm">Import now</button></form>
                </>
              )}
              {owner && (!conn || conn.status !== "active") && <a className="btn btn-primary btn-sm" href={`/api/erp/${p}/connect`}>{conn ? "Reconnect" : "Connect"}</a>}
              {owner && conn && <form action={disconnectErp}><input type="hidden" name="provider" value={p} /><button className="btn btn-ghost btn-sm">Disconnect</button></form>}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">A buyer must already be one of your linked buyers, and the invoice needs a due date. QuickBooks has no GST number field, so the customer name must match one of your linked buyers exactly (a custom invoice field named &quot;Buyer GSTIN&quot; is used instead if you add one).</p>
    </Panel>
  );
}
