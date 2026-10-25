import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { recordConsent } from "@/server/underwriting/service";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { businesses } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { submitKyb, submitLightKyb } from "@/server/kyb/service";
import { submitForeignKyb } from "@/server/crossborder/service";
import { Card, PageHead } from "@/components/ui/cards";
import { Icon } from "@/components/ui/icons";
import { market } from "@/lib/countries";

// The identifiers are checked against the country pack inside the service, so this only shapes the form data.
const Form = z.object({
  pan: z.string(),
  gstin: z.string().optional(),
  cin: z.string().optional(),
  uboName: z.string().min(2),
  uboDin: z.string().optional(),
  accountNumber: z.string(),
  ifsc: z.string(),
  holderName: z.string().min(2),
});

const CONSENT_TEXT =
  "I authorise Marichi Labs and its partners to obtain my and my business's credit information from credit bureaus for assessing financing eligibility.";

/** Bureau-pull consent must be captured (and kept) before any pull: PRD 12.5. */
async function captureConsent(fd: FormData, user: { id: string; businessId: string | null }) {
  if (fd.get("consent") !== "on") throw new Error("consent is required");
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0].trim();
  await recordConsent(db, { businessId: user.businessId!, userId: user.id, text: CONSENT_TEXT, ip });
}

async function submit(fd: FormData) {
  "use server";
  const user = await requireUser(["seller", "buyer", "financier"]);
  if (!user.businessId) throw new Error("no business linked");
  const f = Form.parse(Object.fromEntries(fd));
  await captureConsent(fd, user);
  await submitKyb(db, {
    businessId: user.businessId,
    pan: f.pan,
    gstin: f.gstin || undefined,
    cin: f.cin || undefined,
    // ponytail: single UBO at 100% in the form; multi-director entry when needed (PRD edge case).
    ubos: [{ name: f.uboName, din: f.uboDin || undefined, shareholdingBps: 10000 }],
    bank: { accountNumber: f.accountNumber, ifsc: f.ifsc, holderName: f.holderName },
  });
  revalidatePath("/onboarding");
}

async function submitLight(fd: FormData) {
  "use server";
  const user = await requireUser(["buyer"]);
  const f = z.object({ gstin: z.string().optional(), pan: z.string() }).parse(Object.fromEntries(fd));
  await captureConsent(fd, user);
  await submitLightKyb(db, { businessId: user.businessId!, pan: f.pan, gstin: f.gstin ?? "" });
  revalidatePath("/onboarding");
}

async function submitForeign(fd: FormData) {
  "use server";
  const user = await requireUser(["buyer"]);
  const f = z.object({ country: z.string().length(2), taxId: z.string().min(4) }).parse(Object.fromEntries(fd));
  await captureConsent(fd, user);
  await submitForeignKyb(db, { businessId: user.businessId!, ...f });
  revalidatePath("/onboarding");
}

const input = "field font-normal";
const STAGES = [["draft", "Details"], ["under_review", "Review"], ["approved", "Verified"]] as const;
const stageOf = (s: string) => (s === "approved" ? 2 : s === "under_review" || s === "submitted" ? 1 : 0);

export default async function Onboarding() {
  const user = await requireUser();
  if (["ops", "compliance", "admin"].includes(user.role)) redirect("/admin");
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, user.businessId!));
  const canSubmit = ["draft", "info_requested", "rejected"].includes(biz.kybStatus);
  const stage = stageOf(biz.kybStatus);
  const buyer = user.role === "buyer";
  const { ids } = market();
  const oneId = ids.kyb.label === ids.taxReg.label; // in Zambia a single number does both jobs
  const hint = (s: string) => <span className="mt-1 block text-xs font-normal text-muted">{s}</span>;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHead title="Business verification" sub={biz.legalName} />

      <ol aria-label="Verification progress" className="mb-6 flex items-center gap-2">
        {STAGES.map(([k, label], n) => (
          <li key={k} className="flex flex-1 items-center gap-2" aria-current={n === stage ? "step" : undefined}>
            <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold transition-colors ${n < stage || (n === 2 && stage === 2) ? "bg-p-700 text-white" : n === stage ? "bg-s-500 text-p-950" : "bg-panel text-faint"}`}>{n < stage || stage === 2 ? <Icon name="check" className="h-4 w-4" /> : n + 1}</span>
            <span className={`text-sm font-medium ${n === stage ? "text-ink" : "text-faint"}`}>{label}</span>
            {n < 2 && <span className="h-px flex-1 bg-hair" />}
          </li>
        ))}
      </ol>

      {biz.kybNote && <p className="mb-4 rounded-lg bg-s-100 px-4 py-3 text-sm text-s-600"><b>Note from our team:</b> {biz.kybNote}</p>}
      {biz.kybStatus === "approved" && (
        <Card>
          <div className="flex items-start gap-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-g-100 text-g-600"><Icon name="shield" /></span>
            <div className="text-sm"><p className="font-semibold">You&apos;re verified</p>
              <p className="mt-1 text-muted">{user.role === "seller" ? "Next, add the buyers who owe you money, then upload an invoice." : buyer ? "Invoices from your suppliers will wait for your confirmation." : "You can now use the platform."}</p>
              <div className="mt-4 flex gap-3">{user.role === "seller" ? <><Link className="btn btn-primary btn-sm" href="/seller/buyers">Add your buyers</Link><Link className="btn btn-ghost btn-sm" href="/seller/invoices">Invoices</Link></> : buyer ? <Link className="btn btn-primary btn-sm" href="/buyer/invoices">Invoices awaiting confirmation</Link> : null}</div>
            </div></div>
        </Card>
      )}
      {(biz.kybStatus === "under_review" || biz.kybStatus === "submitted") && (
        <Card><div className="flex items-start gap-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-s-100 text-s-600"><Icon name="clock" /></span>
          <div className="text-sm"><p className="font-semibold">Under review</p><p className="mt-1 text-muted">Our team is checking your details. You&apos;ll get a notification as soon as there is a decision. You don&apos;t need to do anything.</p></div></div></Card>
      )}

      {canSubmit && buyer && (
        <Card title="Your company">
          <form action={submitLight} className="space-y-4 text-sm">
            {!oneId && <label className="block font-medium">{ids.taxReg.label}<input name="gstin" required className={input} />{hint(ids.taxReg.hint)}</label>}
            <label className="block font-medium">{oneId ? ids.kyb.label : `Business ${ids.kyb.label}`}<input name="pan" required className={input} />{hint(ids.kyb.hint)}</label>
            <label className="flex items-start gap-3 text-[13.5px] text-muted"><input name="consent" type="checkbox" required className="mt-0.5" />{CONSENT_TEXT}</label>
            <button className="btn btn-primary">Verify</button>
          </form>
          <details className="mt-5 border-t border-hair pt-4 text-sm">
            <summary className="cursor-pointer font-semibold text-p-700">Is your company based outside {market().name}?</summary>
            <form action={submitForeign} className="mt-3 space-y-4">
              <label className="block font-medium">Country (two-letter code, for example US, GB, AE)<input name="country" required maxLength={2} className={`${input} uppercase`} /></label>
              <label className="block font-medium">Tax or company registration number<input name="taxId" required className={input} /></label>
              <label className="flex items-start gap-3 text-[13.5px] text-muted"><input name="consent" type="checkbox" required className="mt-0.5" />{CONSENT_TEXT}</label>
              <button className="btn btn-ghost">Verify as an overseas company</button>
            </form>
          </details>
        </Card>
      )}
      {canSubmit && !buyer && (
        <form action={submit} className="space-y-4 text-sm">
          <Card title="Business identity">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block font-medium">{oneId ? ids.kyb.label : `Business ${ids.kyb.label}`}<input name="pan" required className={input} />{hint(ids.kyb.hint)}</label>
              {!oneId && <label className="block font-medium">{ids.taxReg.label}<input name="gstin" required className={input} />{hint(ids.taxReg.hint)}</label>}
              {ids.companyReg && <label className="block font-medium sm:col-span-2">{ids.companyReg.label} <span className="font-normal text-faint">(if applicable)</span><input name="cin" className={input} />{hint(ids.companyReg.hint)}</label>}
            </div>
          </Card>
          <Card title="Director or beneficial owner">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block font-medium">Full name<input name="uboName" required className={input} /></label>
              <label className="block font-medium">{ids.director} <span className="font-normal text-faint">(optional)</span><input name="uboDin" className={input} /></label>
            </div>
          </Card>
          <Card title="Settlement bank account">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block font-medium">{ids.bankAccount.label}<input name="accountNumber" required className={input} />{hint(ids.bankAccount.hint)}</label>
              <label className="block font-medium">{ids.bankCode.label}<input name="ifsc" required className={input} />{hint(ids.bankCode.hint)}</label>
              <label className="block font-medium sm:col-span-2">Account holder name<input name="holderName" required className={input} /></label>
            </div>
            <p className="mt-3 text-xs text-muted">Advances are paid to this account. The holder name must match your business name.</p>
          </Card>
          <label className="flex items-start gap-3 text-[13.5px] text-muted"><input name="consent" type="checkbox" required className="mt-0.5" />{CONSENT_TEXT}</label>
          <button className="btn btn-primary">Submit for verification</button>
        </form>
      )}
    </div>
  );
}
