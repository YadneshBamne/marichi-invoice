"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Makes every action feel immediate without touching each page:
 *  - a form being submitted gets `data-pending`, which dims and locks its buttons and shows a spinner (see globals.css);
 *  - a thin progress bar runs while a link navigation is loading.
 * Forms clear when React resets them after the server action finishes (or after 30 s as a safety net).
 */
export function PendingForms() {
  const path = usePathname();
  const [bar, setBar] = useState(false);

  useEffect(() => {
    const submit = (e: Event) => {
      const f = e.target as HTMLFormElement;
      if (!(f instanceof HTMLFormElement) || e.defaultPrevented) return;
      setTimeout(() => {
        f.setAttribute("data-pending", "");
        const clear = () => { f.removeAttribute("data-pending"); f.removeEventListener("reset", clear); };
        f.addEventListener("reset", clear);
        setTimeout(clear, 30_000);
      }, 0);
    };
    const click = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank" || a.hasAttribute("download")) return;
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin || (u.pathname === location.pathname && u.search === location.search)) return;
      setBar(true);
    };
    document.addEventListener("submit", submit, true);
    document.addEventListener("click", click, true);
    return () => { document.removeEventListener("submit", submit, true); document.removeEventListener("click", click, true); };
  }, []);

  useEffect(() => { setBar(false); }, [path]); // navigation finished
  useEffect(() => { if (!bar) return; const t = setTimeout(() => setBar(false), 15_000); return () => clearTimeout(t); }, [bar]);

  return bar ? <div aria-hidden className="nav-bar fixed top-0 left-0 z-[120] h-[3px] bg-p-600" /> : null;
}
