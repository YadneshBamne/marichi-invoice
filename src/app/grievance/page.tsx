import { ESCALATION_MATRIX, grievanceOfficer, isGrievanceConfigured, ombudsman } from "@/lib/grievance";
import { PublicFrame } from "@/components/ui/public";

// Public on purpose: the grievance officer's details and the escalation path must be disclosed to everyone (PRD Module 16).
export const metadata = { title: "Grievance redressal | Marichi Labs" };

export default function Grievance() {
  const o = grievanceOfficer();
  return (
    <PublicFrame wide>
      <h1 className="page-title mb-4">Grievance redressal</h1>
      {!isGrievanceConfigured() && process.env.NODE_ENV === "production" && (
        <p className="mt-3 rounded bg-r-100 p-3 text-r-600">Grievance officer details are not configured. Set the GRIEVANCE_OFFICER_* environment variables before launch.</p>
      )}
      <h2 className="mt-6 font-medium">Grievance officer</h2>
      <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-y-1">
        <dt className="text-faint">Name</dt><dd>{o.name}</dd>
        <dt className="text-faint">Email</dt><dd>{o.email}</dd>
        <dt className="text-faint">Phone</dt><dd>{o.phone}</dd>
        <dt className="text-faint">Address</dt><dd>{o.address}</dd>
      </dl>

      <h2 className="mt-6 font-medium">How we handle complaints</h2>
      <ol className="mt-2 space-y-2">
        {ESCALATION_MATRIX.map((s) => (
          <li key={s.level} className="rounded-card bg-card p-3 shadow-card"><b>Level {s.level}: {s.who}</b><div className="text-muted">{s.within}</div></li>
        ))}
      </ol>

      <h2 className="mt-6 font-medium">Ombudsman</h2>
      <p className="mt-2">You can approach the {ombudsman().name} ({ombudsman().url}) {ombudsman().when}.</p>
      <p className="mt-6"><a className="underline" href="/support">Raise a grievance →</a></p>
    </PublicFrame>
  );
}
