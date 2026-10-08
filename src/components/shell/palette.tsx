"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icons";
import type { Section } from "./nav";

type Cmd = { id: string; label: string; hint: string; icon: string; group: string; run: () => void };

/** Ctrl/Cmd+K: jump to any page or run a common action. Built from the same nav model as the sidebar. */
export function CommandPalette({ open, onClose, sections, actions }: { open: boolean; onClose: () => void; sections: Section[]; actions: { label: string; icon: string; run: () => void }[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const all = useMemo<Cmd[]>(() => [
    ...sections.flatMap((s) => s.items.map((i) => ({
      id: i.href, label: i.label, hint: i.soon ? `Coming soon · Phase ${i.phase}` : s.label, icon: i.icon, group: i.soon ? "Coming soon" : "Go to",
      run: () => router.push(i.href),
    }))),
    ...actions.map((a) => ({ id: `a:${a.label}`, label: a.label, hint: "Action", icon: a.icon, group: "Actions", run: a.run })),
  ], [sections, actions, router]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? all.filter((c) => c.label.toLowerCase().includes(t) || c.hint.toLowerCase().includes(t)) : all;
  }, [all, q]);

  useEffect(() => { if (open) { setQ(""); setAt(0); } }, [open]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" }); }, [at]);

  const go = (c?: Cmd) => { if (!c) return; onClose(); c.run(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); go(shown[at]); }
  };

  let lastGroup = "";
  return (
    <Dialog open={open} onClose={onClose} label="Command palette" className="max-w-xl overflow-hidden" top>
      <div className="flex items-center gap-3 border-b border-hair px-4">
        <Icon name="search" className="h-5 w-5 text-faint" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search pages and actions" aria-label="Search pages and actions"
          className="h-14 flex-1 border-0 bg-transparent p-0 text-[15px] shadow-none focus:shadow-none focus:border-0" />
        <kbd className="rounded border border-hair px-1.5 py-0.5 text-[11px] text-faint">Esc</kbd>
      </div>
      <ul ref={list} role="listbox" className="scroll-thin max-h-[48vh] overflow-y-auto p-2">
        {shown.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">No results for &ldquo;{q}&rdquo;.</li>}
        {shown.map((c, i) => {
          const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
          return (
            <li key={c.id} role="presentation">
              {head && <p className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-[.06em] text-faint uppercase">{head}</p>}
              <button role="option" aria-selected={i === at} data-i={i} onMouseMove={() => setAt(i)} onClick={() => go(c)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${i === at ? "bg-p-100 text-p-950" : ""}`}>
                <Icon name={c.icon} className="h-4.5 w-4.5 text-p-600" />
                <span className="flex-1 font-medium">{c.label}</span>
                <span className="text-xs text-faint">{c.hint}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-4 border-t border-hair bg-page px-4 py-2 text-[11.5px] text-faint">
        <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span>
      </div>
    </Dialog>
  );
}
