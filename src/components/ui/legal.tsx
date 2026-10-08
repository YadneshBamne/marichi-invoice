import { PublicFrame } from "./public";

export type LegalSection = { h: string; p: string[] };

/** Plain structured document page. The banner is deliberate: these texts are drafts until counsel signs them off. */
export function LegalPage({ title, updated, sections }: { title: string; updated: string; sections: LegalSection[] }) {
  return (
    <PublicFrame wide>
      <p className="mb-6 rounded-lg bg-s-100 px-4 py-3 text-sm text-s-600"><b>Draft for legal review.</b> This text is a working draft and is not yet in force.</p>
      <h1 className="page-title">{title}</h1>
      <p className="page-sub">Last updated {updated}</p>
      <div className="mt-8 space-y-7">
        {sections.map((s, n) => (
          <section key={s.h}>
            <h2 className="text-[17px] font-semibold tracking-tight">{n + 1}. {s.h}</h2>
            {s.p.map((t) => <p key={t} className="mt-2 text-[15px] leading-relaxed text-muted">{t}</p>)}
          </section>
        ))}
      </div>
    </PublicFrame>
  );
}
