import Link from "next/link";
import { Icon } from "@/components/ui/icons";

export const metadata = { title: "Not found" };

export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-xl py-10 text-center">
      <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-p-100 text-p-700"><Icon name="compass" className="h-8 w-8" /></span>
      <p className="mt-6 text-xs font-semibold tracking-[.14em] text-faint uppercase">Error 404</p>
      <h1 className="page-title mt-2">We couldn&apos;t find that</h1>
      <p className="page-sub mx-auto max-w-md">The record may have been removed, or the link may be wrong. Press Ctrl K to search for a page.</p>
      <div className="mt-6 flex justify-center gap-3">
        <Link href="/dashboard" className="btn btn-primary">Go to dashboard</Link>
        <Link href="/support" className="btn btn-ghost">Contact support</Link>
      </div>
    </div>
  );
}
