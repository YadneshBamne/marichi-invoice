import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "./icons";

import { Panel } from "./page";
export { PageHead } from "./page";

/** Kept for the dashboards: a Panel with the same API as before. */
export function Card({ title, action, className = "", tour, children }: { title?: string; action?: ReactNode; className?: string; tour?: string; children: ReactNode }) {
  return <Panel title={title} action={action} className={className} tour={tour}>{children}</Panel>;
}

const TONES = {
  neutral: "bg-panel text-muted",
  good: "bg-p-100 text-p-700",
  warn: "bg-s-100 text-s-600",
  bad: "bg-r-100 text-r-600",
  info: "bg-i-100 text-i-500",
} as const;
export type Tone = keyof typeof TONES;
export const Pill = ({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) => <span className={`pill ${TONES[tone]}`}>{children}</span>;

/** KPI card. `hero` uses the dark brand fill; `href` makes the whole card a link (arrow badge). */
export function Stat({ label, value, note, tone, hero, href }: { label: string; value: string; note?: string; tone?: Tone; hero?: boolean; href?: string }) {
  const body = (
    <div className={`relative flex min-h-[132px] flex-col overflow-hidden rounded-card p-5 shadow-card sm:p-6 ${hero ? "bg-p-800 text-white" : "bg-card"}`}>
      <div className="flex items-start justify-between gap-3">
        <span className={`text-[15px] font-medium ${hero ? "text-lt-100" : "text-muted"}`}>{label}</span>
        {href && <span className={`grid h-9 w-9 place-items-center rounded-full ${hero ? "bg-white/15" : "bg-panel"}`}><Icon name="arrow" className="h-4 w-4" /></span>}
      </div>
      <div className="mt-auto pt-5 text-[clamp(30px,3.2vw,40px)] font-semibold leading-none tracking-tight">{value}</div>
      {note && <div className={`mt-2 text-[13px] ${hero ? "text-lt-200" : tone ? TONES[tone].split(" ")[1] : "text-muted"}`}>{note}</div>}
    </div>
  );
  return href ? <Link href={href} className="block lift rounded-card">{body}</Link> : body;
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-card bg-panel px-4 py-6 text-center text-sm text-muted">{children}</p>;
