import Link from "next/link";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { businesses } from "@/server/db/schema";
import { requireUser } from "@/server/rbac";
import { setCompanyLogo, updateCompany } from "@/server/company/service";
import { can } from "@/server/permissions";
import { Card, Empty, Pill, type Tone } from "@/components/ui/cards";
import { CompanyMark } from "@/components/shell/sidebar";
import { formatINR } from "@/lib/money";
import { ROLE_META } from "@/components/shell/nav";

export const metadata = { title: "Company" };
const TONE: Record<string, Tone> = { approved: "good", under_review: "warn", submitted: "warn", rejected: "bad", info_requested: "warn" };
const mask = (v: string | null) => (v ? `${v.slice(0, 2)}${"•".repeat(Math.max(v.length - 4, 0))}${v.slice(-2)}` : "Not provided");
const INDUSTRIES = ["Manufacturing", "Textiles and apparel", "Food and agriculture", "Pharma and healthcare", "Electronics", "Logistics", "Construction", "Retail and distribution", "IT and services", "Other"];

async function save(fd: FormData) {
  "use server";
  const u = await requireUser(["seller", "buyer", "financier"]);
  const actor = { id: u.id, role: u.role, orgRole: u.orgRole, businessId: u.businessId };
  await updateCompany(db, actor, { displayName: String(fd.get("name") ?? ""), phone: String(fd.get("phone") ?? ""), city: String(fd.get("city") ?? ""), industry: String(fd.get("industry") ?? "") });
  const logo = fd.get("logo");
  if (logo instanceof File && logo.size > 0) await setCompanyLogo(db, actor, Buffer.from(await logo.arrayBuffer()), logo.type);
  revalidatePath("/", "layout"); // the sidebar shows the name and picture
}

export default async function Organization() {
  const u = await requireUser();
  if (!u.businessId) return <Empty>Staff accounts ({ROLE_META[u.role]?.label}) aren&apos;t linked to a company.</Empty>;
  const [b] = await db.select().from(businesses).where(eq(businesses.id, u.businessId));
  const edit = can(u, "company.edit");
  const name = b.displayName ?? b.legalName;
  const rows: [string, React.ReactNode][] = [
    ["Legal name", b.legalName], ["Entity type", b.entityType.replaceAll("_", " ")], ["GSTIN", b.gstin ?? "Not provided"], ["PAN", mask(b.pan)], ["CIN", b.cin ?? "Not provided"],
    ["Verification", <Pill key="k" tone={TONE[b.kybStatus] ?? "neutral"}>{b.kybStatus.replaceAll("_", " ")}</Pill>],
    ...(u.role === "seller" ? [["Credit limit", b.creditLimit > 0n ? formatINR(b.creditLimit) : "Default policy limit"] as [string, React.ReactNode]] : []),
  ];
  return (
    <div className="space-y-5">
      <Card title="Company profile" tour="company-profile">
        <form action={save} className="grid gap-6 sm:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center gap-3">
            <CompanyMark name={name} logoUrl={u.biz?.logoRef ? `/api/company/logo?v=${u.biz.logoRef.slice(0, 12)}` : null} className="h-28 w-28 !rounded-3xl text-2xl" />
            {edit && <label className="btn btn-ghost btn-sm cursor-pointer">Change picture<input name="logo" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" /></label>}
            <p className="text-center text-xs text-faint">PNG, JPEG or WebP, under 1 MB</p>
          </div>
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            <label className="block font-medium sm:col-span-2">Company name<input name="name" defaultValue={name} readOnly={!edit} required minLength={2} maxLength={60} className="field font-normal" /></label>
            <label className="block font-medium">Phone<input name="phone" defaultValue={b.phone ?? ""} readOnly={!edit} className="field font-normal" /></label>
            <label className="block font-medium">City<input name="city" defaultValue={b.city ?? ""} readOnly={!edit} className="field font-normal" /></label>
            <label className="block font-medium sm:col-span-2">Industry
              <select name="industry" defaultValue={b.industry ?? ""} disabled={!edit} className="field font-normal"><option value="">Not set</option>{INDUSTRIES.map((i) => <option key={i}>{i}</option>)}</select></label>
            {edit ? <div className="sm:col-span-2"><button className="btn btn-primary">Save changes</button></div> : <p className="text-xs text-muted sm:col-span-2">Only the company owner can edit these details.</p>}
          </div>
        </form>
      </Card>

      <Card title="Legal and verification" action={<Link href="/onboarding" className="text-sm font-semibold text-p-700">Verification</Link>}>
        <dl className="divide-y divide-hair text-sm">
          {rows.map(([k, v]) => <div key={k} className="grid grid-cols-3 gap-4 py-3"><dt className="text-muted">{k}</dt><dd className="col-span-2 font-medium capitalize-first">{v}</dd></div>)}
        </dl>
        {b.kybNote && <p className="mt-3 rounded-lg bg-s-100 p-3 text-sm">{b.kybNote}</p>}
        <p className="mt-4 text-xs text-muted">To correct legal details, raise a support request. Changes are re-verified.</p>
      </Card>
    </div>
  );
}
