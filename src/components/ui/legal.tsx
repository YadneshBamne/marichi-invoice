import { PublicFrame } from "./public";

export type LegalSection = { h: string; p: string[] };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Structured document page with a contents list beside it on wide screens. The banner is deliberate: these texts are drafts until counsel signs them off. */
export function LegalPage({ title, updated, sections }: { title: string; updated: string; sections: LegalSection[] }) {
  return (
    <PublicFrame doc>
      <p className="mb-6 rounded-lg bg-s-100 px-4 py-3 text-sm text-s-600"><b>Draft for legal review.</b> This text is a working draft and is not yet in force.</p>
      <h1 className="page-title">{title}</h1>
      <p className="page-sub">Last updated {updated}</p>
      <div className="mt-8 grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Contents" className="hidden lg:block">
          <ol className="sticky top-24 space-y-1 border-l border-hair text-sm">
            {sections.map((s, n) => (
              <li key={s.h}><a href={`#${slug(s.h)}`} className="-ml-px block border-l-2 border-transparent py-1 pl-4 text-muted transition-colors hover:border-p-600 hover:text-ink">{n + 1}. {s.h}</a></li>
            ))}
          </ol>
        </nav>
        <div className="space-y-7">
          {sections.map((s, n) => (
            <section key={s.h} id={slug(s.h)} className="scroll-mt-24">
              <h2 className="text-[17px] font-semibold tracking-tight">{n + 1}. {s.h}</h2>
              {s.p.map((t) => <p key={t} className="mt-2 text-[15px] leading-relaxed text-muted">{t}</p>)}
            </section>
          ))}
        </div>
      </div>
    </PublicFrame>
  );
}
