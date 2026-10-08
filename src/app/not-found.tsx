import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { PublicFooter, PublicHeader } from "@/components/ui/public";

export const metadata = { title: "Page not found" };

// Unmatched URLs land here, outside the signed-in shell, so it works for visitors and signed-in users alike.
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col bg-page">
      <PublicHeader />
      <main className="anim-up mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <p className="text-[clamp(72px,16vw,128px)] leading-none font-semibold tracking-tighter text-p-700/15">404</p>
        <span className="-mt-8 grid h-14 w-14 place-items-center rounded-2xl bg-p-100 text-p-700"><Icon name="compass" className="h-7 w-7" /></span>
        <h1 className="page-title mt-5">This page doesn&apos;t exist</h1>
        <p className="page-sub max-w-md">The address may be mistyped, or the page may have moved. These will get you back on track.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link href="/dashboard" className="btn btn-primary">Go to my dashboard</Link>
          <Link href="/" className="btn btn-ghost">Home</Link>
          <Link href="/grievance" className="btn btn-ghost">Contact us</Link>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
