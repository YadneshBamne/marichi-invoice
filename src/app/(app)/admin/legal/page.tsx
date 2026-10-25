import { requireUser } from "@/server/rbac";
import { COUNTRIES, CRITICAL_CLAUSES, STACK } from "@/server/agreements/stack";
import { DataTable, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";

export const metadata = { title: "Legal documents" };

export default async function Legal() {
  await requireUser(["ops", "compliance", "admin"]);
  return (
    <>
      <PageHead title="Legal documents" sub="Every document the platform relies on, who signs it and when. All wording is a draft until counsel has reviewed it for each country." />
      <div className="mb-5"><Notice tone="warn">Clause text and country settings are drafts. They are not legal advice and must be reviewed by a lawyer in each country before real money moves there.</Notice></div>
      <Panel title="The agreement stack" className="mb-5" flush>
        <DataTable rows={STACK} rowKey={(s) => String(s.n)}
          cols={[
            { h: "#", cell: (s) => s.n },
            { h: "Document", cell: (s) => s.name },
            { h: "Signed by", cell: (s) => <span className="font-normal text-muted">{s.signer}</span> },
            { h: "When", cell: (s) => <span className="font-normal text-muted">{s.when}</span> },
            { h: "In the product", cell: (s) => <StatusPill status={s.how === "external" ? "pending" : "approved"} label={s.how} /> },
            { h: "Where", cell: (s) => <span className="font-normal text-muted">{s.where}</span> },
            { h: "Version", cell: (s) => <span className="font-mono text-xs font-normal">{s.version}</span> },
          ]} />
      </Panel>
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Five clauses not to leave to a template">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">{CRITICAL_CLAUSES.map((c) => <li key={c}>{c}</li>)}</ol>
        </Panel>
        <Panel title="Country settings in the agreements" flush>
          <DataTable rows={COUNTRIES} rowKey={(c) => c.code}
            cols={[
              { h: "Country", cell: (c) => c.name },
              { h: "Governing law", cell: (c) => <span className="font-normal text-muted">{c.law}</span> },
              { h: "Registry", cell: (c) => <span className="font-normal text-muted">{c.registry ?? "-"}</span> },
              { h: "E-signature law", cell: (c) => <span className="font-normal text-muted">{c.esign}</span> },
            ]} />
        </Panel>
      </div>
    </>
  );
}
