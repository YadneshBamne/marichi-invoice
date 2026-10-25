import Link from "next/link";
import { ESCALATION_MATRIX, grievanceOfficer, isGrievanceConfigured, ombudsman } from "@/lib/grievance";
import { PublicFrame } from "@/components/ui/public";

// Public on purpose: the grievance officer's details and the escalation path must be disclosed to everyone (PRD Module 16).
export const metadata = { title: "Grievance redressal" };

export default function Grievance() {
  const o = grievanceOfficer();
  const om = ombudsman();
  return (
    <PublicFrame wide>
      <h1 className="page-title">Grievance redressal</h1>
      <p className="page-sub">If something has gone wrong, here is who to tell and what happens next.</p>
      {!isGrievanceConfigured() && process.env.NODE_ENV === "production" && (
        <p className="mt-5 rounded-lg bg-r-100 px-4 py-3 text-sm text-r-600">Grievance officer details are not configured. Set the GRIEVANCE_OFFICER_* environment variables before launch.</p>
      )}

      <section className="mt-8">
        <h2 className="text-[17px] font-semibold tracking-tight">Grievance officer</h2>
        <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-6 gap-y-2 rounded-card bg-panel p-5 text-[15px]">
          <dt className="text-muted">Name</dt><dd className="font-medium">{o.name}</dd>
          <dt className="text-muted">Email</dt><dd className="font-medium">{o.email}</dd>
          <dt className="text-muted">Phone</dt><dd className="font-medium">{o.phone}</dd>
          <dt className="text-muted">Address</dt><dd className="font-medium">{o.address}</dd>
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="text-[17px] font-semibold tracking-tight">How we handle complaints</h2>
        <ol className="mt-3 space-y-3">
          {ESCALATION_MATRIX.map((s) => (
            <li key={s.level} className="flex gap-4 rounded-card bg-panel p-4">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-p-700 text-sm font-bold text-white">{s.level}</span>
              <span><b className="block">{s.who}</b><span className="text-[14.5px] text-muted">{s.within}</span></span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-8">
        <h2 className="text-[17px] font-semibold tracking-tight">Ombudsman</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">You can approach the {om.name} ({om.url}) {om.when}.</p>
      </section>

      <div className="mt-8"><Link className="btn btn-primary" href="/support">Raise a grievance</Link></div>
    </PublicFrame>
  );
}
