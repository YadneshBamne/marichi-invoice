import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { can } from "@/server/permissions";
import { institutionLabel, institutions, profileOf, saveApplication } from "@/server/marketplace/financier";
import { financierTerms } from "@/server/agreements/templates";
import { putDocument } from "@/server/vault";
import { Field, Notice, PageHead, Panel, StatusPill } from "@/components/ui/page";
import { attempt } from "../attempt";
import { market } from "@/lib/countries";

export const metadata = { title: "Financier application" };
const PATH = "/financier/application";
const input = "field font-normal";

const Form = z.object({
  institutionType: z.string(), countries: z.string(), regulator: z.string(), licenceType: z.string(), licenceNumber: z.string(),
  licenceValidUntil: z.string().optional(), settlementAccount: z.string(), settlementIfsc: z.string(), settlementName: z.string(),
});

async function save(fd: FormData) {
  "use server";
  const u = await requireUser(["financier"]);
  await attempt(PATH, async () => {
    const f = Form.parse(Object.fromEntries(fd));
    const file = fd.get("licence");
    let licenceDocRef: string | undefined;
    if (file instanceof File && file.size > 0) licenceDocRef = (await putDocument(Buffer.from(await file.arrayBuffer()), file.type)).ref;
    const submit = fd.get("intent") === "submit";
    await saveApplication(db, { id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId }, {
      ...f, countries: f.countries.split(/[\s,;]+/), licenceValidUntil: f.licenceValidUntil || null, licenceDocRef, acceptTerms: fd.get("terms") === "on",
    }, submit);
    return submit ? "Sent to our team. We will review your licence and tell you the outcome." : "Draft saved.";
  });
}

const WORDS: Record<string, string> = {
  draft: "Not sent yet", submitted: "With our team", info_requested: "We need more from you", approved: "Approved", rejected: "Not approved", suspended: "Suspended",
};

export default async function Application({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireUser(["financier"]);
  const q = await searchParams;
  const p = await profileOf(db, u.businessId!);
  const editable = !p || ["draft", "info_requested", "rejected"].includes(p.status);
  const may = can(u, "financier.apply");
  const kybOk = u.biz?.kybStatus === "approved";
  return (
    <>
      <PageHead title="Financier application" sub="Financiers are licensed institutions. Tell us who regulates you and the licence you work under. Our team checks it before you can fund invoices or hold funds with us." />
      {q.ok && <div className="mb-4"><Notice tone="good">{q.ok}</Notice></div>}
      {q.error && <div className="mb-4"><Notice tone="bad">{q.error}</Notice></div>}
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Panel title="1. Verify your company"><p className="text-sm text-muted">Company verification (KYB) comes first. {kybOk ? <StatusPill status="approved" label="Verified" /> : <><StatusPill status="pending" label={u.biz?.kybStatus?.replaceAll("_", " ") ?? "not started"} /> <a className="ml-2 font-semibold text-p-700 underline" href="/onboarding">Continue verification</a></>}</p></Panel>
        <Panel title="2. Licence and settlement account">
          <p className="text-sm text-muted">{p ? <>Status: <StatusPill status={p.status === "approved" ? "approved" : p.status === "submitted" ? "pending" : p.status === "draft" ? "pending" : "rejected"} label={WORDS[p.status]} /></> : "Not started."}</p>
          {p?.note && <p className="mt-2 rounded-lg bg-s-100 p-3 text-sm text-s-600">From our team: {p.note}</p>}
        </Panel>
      </div>
      {!may && <div className="mb-4"><Notice tone="warn">Only an owner or approver can complete this application.</Notice></div>}
      {may && editable && (
        <Panel title="Licence and settlement account">
          <form action={save} className="grid gap-4 sm:grid-cols-2">
            <Field label="What kind of institution are you?"><select name="institutionType" defaultValue={p?.institutionType ?? Object.keys(institutions())[1]} className={input}>{Object.entries(institutions()).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Countries you are licensed to lend or factor in" hint="Two-letter codes, separated by commas: IN, ZM, KE."><input name="countries" required defaultValue={p?.countries.join(", ") ?? market().code} className={`${input} uppercase`} /></Field>
            <Field label="Regulator" hint={`For example ${market().regulator}.`}><input name="regulator" required defaultValue={p?.regulator ?? ""} className={input} /></Field>
            <Field label="Licence type"><input name="licenceType" required defaultValue={p?.licenceType ?? ""} placeholder="NBFC-Factor, financial institution licence" className={input} /></Field>
            <Field label="Licence or registration number"><input name="licenceNumber" required defaultValue={p?.licenceNumber ?? ""} className={input} /></Field>
            <Field label="Licence valid until" hint="Leave blank if it has no expiry."><input name="licenceValidUntil" type="date" defaultValue={p?.licenceValidUntil ?? ""} className={input} /></Field>
            <Field label="Copy of the licence (PDF, PNG or JPG, up to 4 MB)" className="sm:col-span-2"><input name="licence" type="file" accept="application/pdf,image/*" className={input} />{p?.licenceDocRef && <span className="mt-1 block text-xs text-muted">A copy is already on file. Choose a file only to replace it.</span>}</Field>
            <p className="text-sm font-semibold sm:col-span-2">Where we pay your repayments and withdrawals</p>
            <Field label="Account holder name"><input name="settlementName" required defaultValue={p?.settlementName ?? ""} className={input} /></Field>
            <Field label="Account number"><input name="settlementAccount" required defaultValue={p?.settlementAccount ?? ""} inputMode="numeric" className={input} /></Field>
            <Field label={market().ids.bankCode.label} hint={market().ids.bankCode.hint}><input name="settlementIfsc" required defaultValue={p?.settlementIfsc ?? ""} className={`${input} uppercase`} /></Field>
            <details className="rounded-xl bg-panel p-4 text-sm sm:col-span-2"><summary className="cursor-pointer font-semibold text-p-700">Financier participation terms</summary><ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted">{financierTerms().blocks.flatMap((b) => ("ol" in b ? b.ol.map((r) => r.map((x) => (typeof x === "string" ? x : x.b)).join("")) : [])).map((t, i) => <li key={i}>{t}</li>)}</ol></details>
            <label className="flex items-start gap-2 text-sm sm:col-span-2"><input name="terms" type="checkbox" className="mt-0.5" />I have read the participation terms and accept them for {u.biz?.displayName ?? u.biz?.legalName ?? "my institution"}. Needed to send the application.</label>
            <div className="flex flex-wrap gap-3 sm:col-span-2">
              <button name="intent" value="draft" className="btn btn-ghost">Save draft</button>
              <button name="intent" value="submit" className="btn btn-primary" disabled={!kybOk} title={kybOk ? undefined : "Finish company verification first"}>Send to our team</button>
              {!kybOk && <span className="self-center text-xs text-muted">Finish company verification first.</span>}
            </div>
          </form>
        </Panel>
      )}
      {p && !editable && (
        <Panel title="What you sent">
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <dt className="text-muted">Institution</dt><dd>{institutionLabel(p.institutionType)}</dd>
            <dt className="text-muted">Licensed in</dt><dd>{p.countries.join(", ")}</dd>
            <dt className="text-muted">Regulator and licence</dt><dd>{p.regulator}, {p.licenceType} {p.licenceNumber}</dd>
            <dt className="text-muted">Valid until</dt><dd>{p.licenceValidUntil ?? "no expiry stated"}</dd>
            <dt className="text-muted">Settlement account</dt><dd>{p.settlementName}, ending {p.settlementAccount?.slice(-4)} {p.settlementVerified ? "(name matched)" : "(name did not match, our team will check)"}</dd>
          </dl>
        </Panel>
      )}
    </>
  );
}
