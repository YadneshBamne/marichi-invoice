import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/rbac";
import { openTicket } from "@/server/support/service";
import { Icon } from "@/components/ui/icons";
import { Card } from "@/components/ui/cards";
import { ROADMAP, roadmapItem } from "@/lib/roadmap";

const STAGES = ["Planned", "In design", "Beta", "Available"];
const CUSTOMER = ["seller", "buyer", "financier"];

async function requestAccess(fd: FormData) {
  "use server";
  const u = await requireUser(CUSTOMER as never);
  const p = roadmapItem(z.string().parse(fd.get("slug")));
  if (!p) return;
  await openTicket(db, u, { kind: "query", subject: `Early access: ${p.title}`, description: `Please add us to the early-access list for ${p.title} (Phase ${p.phase}).` });
  redirect(`/soon/${p.slug}?sent=1`);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const p = roadmapItem((await params).slug);
  return { title: p ? `${p.title} (coming soon)` : "Coming soon" };
}

export default async function Soon({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ sent?: string }> }) {
  const sent = (await searchParams).sent === "1";
  const u = await requireUser();
  const p = roadmapItem((await params).slug);
  if (!p) notFound();
  const others = ROADMAP.filter((x) => x.slug !== p.slug && x.roles.includes(u.role as never)).slice(0, 3);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="relative overflow-hidden rounded-panel bg-p-950 p-6 text-white sm:p-10">
        <div aria-hidden className="hatch pointer-events-none absolute -top-10 -right-10 h-64 w-64 rounded-full opacity-[.12]" />
        <div aria-hidden className="pointer-events-none absolute right-6 bottom-6 hidden h-24 w-24 rounded-full border-[10px] border-white/8 sm:block" />
        <span className="pill bg-s-500 text-p-950">Phase {p.phase} · Planned</span>
        <div className="mt-5 flex items-center gap-4">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-white/10"><Icon name={p.icon} className="h-7 w-7" /></span>
          <h1 className="page-title text-white">{p.title}</h1>
        </div>
        <p className="mt-4 max-w-2xl text-[15.5px] leading-relaxed text-p-100/85">{p.summary}</p>
        <p className="mt-4 text-sm text-p-200/70">This module is not available yet. Nothing on this page is active, and no dates are committed.</p>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card title="What it will include" className="lg:col-span-2">
          <ul className="stagger grid gap-3 sm:grid-cols-2">
            {p.bullets.map((b) => (
              <li key={b} className="flex gap-3 rounded-lg bg-page p-4 text-[14px]"><Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-p-600" />{b}</li>
            ))}
          </ul>
        </Card>
        <Card title="Status">
          <ol className="space-y-3">
            {STAGES.map((s, n) => (
              <li key={s} className={`flex items-center gap-3 text-sm ${n === 0 ? "font-semibold" : "text-faint"}`}>
                <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] ${n === 0 ? "bg-p-700 text-white" : "bg-panel"}`}>{n === 0 ? <Icon name="check" className="h-3 w-3" /> : n + 1}</span>{s}
              </li>
            ))}
          </ol>
          {sent && <p role="status" className="anim-pop mt-4 rounded-lg bg-g-100 px-3 py-2.5 text-sm text-g-600">Thanks. We have added you to the early-access list and will be in touch.</p>}
          {CUSTOMER.includes(u.role) && !sent ? (
            <form action={requestAccess} className="mt-5 border-t border-hair pt-4">
              <input type="hidden" name="slug" value={p.slug} />
              <button className="btn btn-primary w-full">Request early access</button>
              <p className="mt-2 text-xs text-muted">Opens a support request so our team can follow up when it is ready.</p>
            </form>
          ) : !sent && <p className="mt-5 border-t border-hair pt-4 text-xs text-muted">Roadmap item. Customers can request early access from this page.</p>}
        </Card>
      </div>

      {others.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 text-[15px] font-semibold">Also on the roadmap</h2>
          <div className="stagger grid gap-3 sm:grid-cols-3">
            {others.map((o) => (
              <Link key={o.slug} href={`/soon/${o.slug}`} className="lift rounded-card bg-card p-4 shadow-card">
                <Icon name={o.icon} className="h-5 w-5 text-p-600" />
                <p className="mt-2 font-semibold">{o.title}</p>
                <p className="mt-1 line-clamp-2 text-[13px] text-muted">{o.summary}</p>
                <p className="mt-3 text-xs font-semibold text-faint">Phase {o.phase}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
