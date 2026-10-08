import Link from "next/link";
import { requireUser } from "@/server/rbac";
import { Icon } from "@/components/ui/icons";
import { ROLE_META } from "@/components/shell/nav";

export const metadata = { title: "Access restricted" };

export default async function Forbidden() {
  const u = await requireUser();
  const meta = ROLE_META[u.role] ?? ROLE_META.seller;
  return (
    <div className="mx-auto max-w-xl py-10 text-center">
      <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-p-100 text-p-700"><Icon name="lock" className="h-8 w-8" /></span>
      <p className="mt-6 text-xs font-semibold tracking-[.14em] text-faint uppercase">Error 403</p>
      <h1 className="page-title mt-2">You don&apos;t have access to this page</h1>
      <p className="page-sub mx-auto max-w-md">Your account is set up as <b>{meta.label.toLowerCase()}</b>, and this area is for a different role. If you think this is a mistake, contact your administrator.</p>
      <div className="mt-6 flex justify-center gap-3">
        <Link href={meta.home} className="btn btn-primary">Back to {u.role === "admin" || u.role === "ops" || u.role === "compliance" ? "console" : "dashboard"}</Link>
        <Link href="/grievance" className="btn btn-ghost">Contact us</Link>
      </div>
    </div>
  );
}
