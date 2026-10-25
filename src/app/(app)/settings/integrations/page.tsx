import { db } from "@/server/db/client";
import { requireApp, requireUser } from "@/server/rbac";
import { listApiKeys } from "@/server/erp/keys";
import { listEndpoints, recentDeliveries } from "@/server/erp/events";
import { DataTable, Notice, Panel, StatusPill } from "@/components/ui/page";
import { NewEndpointForm, NewKeyForm } from "./forms";
import { revokeKey, testEndpoint, toggleEndpoint } from "./actions";

export const metadata = { title: "Integrations" };
const when = (d: Date | null) => (d ? d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never");

const CURL_READ = `# your invoices
curl "https://YOUR-DOMAIN/api/v1/invoices?status=financed" \\
  -H "Authorization: Bearer mk_live_..."

# one invoice
curl https://YOUR-DOMAIN/api/v1/invoices/INV-001 -H "Authorization: Bearer mk_live_..."`;
const CURL_BUYER = `

# answer an invoice raised on you: confirm, dispute or clarify (a note is needed for the last two)
curl -X POST https://YOUR-DOMAIN/api/v1/invoices/INV-001/response \\
  -H "Authorization: Bearer mk_live_..." -H "content-type: application/json" \\
  -d '{"decision":"confirm"}'`;
const CURL_WRITE = `

# raise an invoice
curl -X POST https://YOUR-DOMAIN/api/v1/invoices \\
  -H "Authorization: Bearer mk_live_..." -H "content-type: application/json" \\
  -d '{"buyerGstin":"29BBBBB2222B1Z5","invoiceNumber":"INV-002","invoiceDate":"2026-10-01","dueDate":"2026-12-01","amount":"118000.00"}'`;

export default async function Integrations() {
  const u = await requireUser(["seller", "buyer"]);
  requireApp(u, "integrations");
  const owner = u.orgRole === "owner";
  const seller = u.role === "seller";
  const [keys, endpoints, deliveries] = await Promise.all([listApiKeys(db, u.businessId!), listEndpoints(db, u.businessId!), recentDeliveries(db, u.businessId!)]);

  return (
    <div className="space-y-5">
      {!owner && <Notice tone="warn">Only the company owner can create keys or webhooks. You can see what is set up.</Notice>}

      <Panel title="API keys" sub={`Let your accounting system or a script read your invoices${seller ? " and raise new ones" : " and answer them"}. A key works for this company only.`} flush={keys.length > 0}>
        {owner && <div className={keys.length ? "border-b border-hair p-5 sm:p-6" : ""}><NewKeyForm /></div>}
        {keys.length > 0 && (
          <DataTable rows={keys} rowKey={(k) => k.id}
            cols={[
              { h: "Name", cell: (k) => k.name },
              { h: "Key", cell: (k) => <span className="font-mono text-[13px] font-normal text-muted">{k.prefix}…</span> },
              { h: "Last used", cell: (k) => <span className="font-normal text-muted">{when(k.lastUsedAt)}</span> },
              { h: "Status", cell: (k) => <StatusPill status={k.revokedAt ? "rejected" : "approved"} label={k.revokedAt ? "revoked" : "active"} /> },
              { h: "", align: "right", cell: (k) => owner && !k.revokedAt && <form action={revokeKey}><input type="hidden" name="id" value={k.id} /><button className="btn btn-ghost btn-sm">Revoke</button></form> },
            ]} />
        )}
      </Panel>

      <Panel title="Webhooks" sub="We call your address when something changes: an offer is ready, money is paid out, an invoice is paid or overdue. Each call is signed." flush={endpoints.length > 0}>
        {owner && <div className={endpoints.length ? "border-b border-hair p-5 sm:p-6" : ""}><NewEndpointForm /></div>}
        {endpoints.length > 0 && (
          <DataTable rows={endpoints} rowKey={(e) => e.id}
            cols={[
              { h: "Address", cell: (e) => <span className="break-all font-normal">{e.url}</span> },
              { h: "Events", cell: (e) => <span className="font-normal text-muted">{e.events.length ? e.events.join(", ") : "all"}</span> },
              { h: "Status", cell: (e) => <StatusPill status={e.active ? "approved" : "pending"} label={e.active ? "active" : "paused"} /> },
              { h: "", align: "right", cell: (e) => owner && (
                <span className="inline-flex gap-2">
                  <form action={testEndpoint}><input type="hidden" name="id" value={e.id} /><button className="btn btn-ghost btn-sm">Send test</button></form>
                  <form action={toggleEndpoint}><input type="hidden" name="id" value={e.id} /><input type="hidden" name="active" value={e.active ? "0" : "1"} /><button className="btn btn-ghost btn-sm">{e.active ? "Pause" : "Resume"}</button></form>
                </span>
              ) },
            ]} />
        )}
      </Panel>

      {deliveries.length > 0 && (
        <Panel title="Recent deliveries" sub="Failed calls are retried over about half a day, then stop." flush>
          <DataTable rows={deliveries} rowKey={({ d }) => d.id}
            cols={[
              { h: "Event", cell: ({ d }) => <span className="font-mono text-[13px]">{d.type}</span> },
              { h: "Status", cell: ({ d }) => <StatusPill status={d.status === "delivered" ? "approved" : d.status === "failed" ? "rejected" : "pending"} label={d.status} /> },
              { h: "Tries", align: "right", cell: ({ d }) => d.attempts },
              { h: "Answer", cell: ({ d }) => <span className="font-normal text-muted">{d.lastError ?? (d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : "-")}</span> },
              { h: "When", cell: ({ d }) => <span className="font-normal text-muted">{when(d.createdAt)}</span> },
            ]} />
        </Panel>
      )}

      <Panel title="Using the API" sub="Plain JSON over HTTPS. Amounts are rupees as text, for example 118000.00.">
        <div className="space-y-4 text-sm">
          {seller && <p>Prefer a spreadsheet? <a className="font-semibold text-p-700 underline" href="/seller/invoices/import">Import invoices from a CSV file</a>, with the exports Tally, Zoho Books and Excel produce.</p>}
          <pre className="overflow-x-auto rounded-lg bg-panel p-4 text-xs leading-relaxed">{CURL_READ + (seller ? CURL_WRITE : CURL_BUYER)}</pre>
          <div>
            <p className="font-semibold">Checking a webhook</p>
            <p className="mt-1 text-muted">Each call carries <code>x-marichi-signature: t=&lt;time&gt;,v1=&lt;hash&gt;</code>. Compute HMAC-SHA256 of <code>&lt;time&gt;.&lt;raw body&gt;</code> with your signing secret, compare it to <code>v1</code>, and reject calls older than five minutes. Answer with any 2xx to confirm; an event is not sent again after a 2xx.</p>
          </div>
          <p className="text-muted">Limits: 120 requests a minute per key. Errors come back as an <code>error</code> object with a code and message, and a matching HTTP status. Sending the same invoice number again returns 409 with the existing invoice, so retries are safe.</p>
        </div>
      </Panel>
    </div>
  );
}
