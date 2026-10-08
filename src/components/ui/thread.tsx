import type { ReactNode } from "react";

export type Msg = { id: string; authorRole: string; body: string; createdAt: Date; internal?: boolean };

const initials = (s: string) => s.slice(0, 2).toUpperCase();

/** A conversation: customer messages, staff replies, system notices and internal notes, each visually distinct. */
export function Thread({ messages, who }: { messages: Msg[]; who: (m: Msg) => ReactNode }) {
  return (
    <ol className="space-y-4">
      {messages.map((m) => {
        const system = m.authorRole === "system";
        const staff = ["ops", "admin", "compliance"].includes(m.authorRole);
        return (
          <li key={m.id} className="flex gap-3">
            <span className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-bold ${system ? "bg-panel text-faint" : staff ? "bg-p-700 text-white" : "bg-s-100 text-s-600"}`}>{system ? "SY" : initials(m.authorRole)}</span>
            <div className={`min-w-0 flex-1 rounded-card px-4 py-3 ${m.internal ? "bg-s-100 ring-1 ring-s-500/30" : system ? "bg-panel" : "bg-card shadow-card"}`}>
              <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
                {m.internal && <span className="pill bg-s-500 text-p-950">Internal note</span>}
                <b className="font-semibold text-ink">{who(m)}</b>
                <time>{m.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</time>
              </p>
              <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed">{m.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
