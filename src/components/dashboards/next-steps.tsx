import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { progress, type Step } from "@/lib/next-steps";

/** Checklist-first: shown above the numbers until every step is done, then it disappears. */
export function NextSteps({ steps, title = "Get started" }: { steps: Step[]; title?: string }) {
  const p = progress(steps);
  if (p.complete) return null;
  return (
    <section data-tour="setup" aria-label={title} className="mb-4 rounded-panel bg-card p-5 shadow-card sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-[15.5px] font-semibold tracking-tight">{title}</h2><p className="text-sm text-muted">{p.done} of {p.total} steps done</p></div>
        <div className="h-2 w-40 overflow-hidden rounded-full bg-panel" role="progressbar" aria-valuenow={p.done} aria-valuemin={0} aria-valuemax={p.total}>
          <div className="h-full rounded-full bg-p-700 transition-all duration-700" style={{ width: `${(p.done / p.total) * 100}%` }} />
        </div>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
        {steps.map((s, n) => {
          const current = n === p.next;
          return (
            <li key={s.id} aria-current={current ? "step" : undefined} className={`flex flex-col rounded-lg p-4 ${s.done ? "bg-g-100/60" : current ? "bg-p-100 ring-1 ring-p-400" : "bg-page"}`}>
              <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${s.done ? "bg-g-600 text-white" : "bg-card text-p-700 ring-1 ring-hair"}`}>{s.done ? <Icon name="check" className="h-3.5 w-3.5" /> : n + 1}</span>
              <p className="mt-3 text-sm font-semibold">{s.title}</p>
              <p className="mt-0.5 text-[13px] text-muted">{s.waiting && current ? s.waiting : s.detail}</p>
              {current && s.waiting && <span className="pill mt-3 self-start bg-s-100 text-s-600"><Icon name="clock" className="h-3 w-3" />Waiting</span>}
              {current && !s.waiting && <Link href={s.href} className="btn btn-primary btn-sm mt-3 self-start">{s.cta}</Link>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
