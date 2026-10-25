"use client";
import { useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icons";

type Choice = "light" | "dark" | "system";
const COOKIE = "marichi-theme";
const EVENT = "marichi:theme-changed";
const CHOICES: [Choice, string][] = [["light", "Light"], ["dark", "Dark"], ["system", "Match device"]];

const saved = (): Choice => { const m = /(?:^|; )marichi-theme=(light|dark)/.exec(document.cookie); return (m?.[1] as Choice | undefined) ?? "system"; };
/** Store the choice and show it now. Outside the component so the lint rule about outside values stays satisfied. */
function choose(c: Choice) {
  document.cookie = c === "system" ? `${COOKIE}=; path=/; max-age=0; samesite=lax` : `${COOKIE}=${c}; path=/; max-age=31536000; samesite=lax`;
  if (c === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = c;
  window.dispatchEvent(new Event(EVENT));
}
const subscribe = (cb: () => void) => { window.addEventListener(EVENT, cb); return () => window.removeEventListener(EVENT, cb); };

/** Light, dark or follow the device. The choice is a cookie so the server renders it on the first byte; it is a viewing preference, not account data. */
export function ThemeSwitch() {
  const choice = useSyncExternalStore(subscribe, saved, () => "system" as Choice);
  return (
    <div className="px-3 py-2">
      <p className="mb-1.5 flex items-center gap-2 text-sm"><Icon name="spark" className="h-4 w-4 text-p-600" />Appearance</p>
      <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-1 rounded-full bg-panel p-1">
        {CHOICES.map(([c, label]) => (
          <button key={c} type="button" role="radio" aria-checked={choice === c} onClick={() => choose(c)}
            className={`rounded-full px-2 py-1 text-xs font-semibold transition-colors ${choice === c ? "bg-card text-ink shadow-card" : "text-muted hover:text-ink"}`}>{label}</button>
        ))}
      </div>
    </div>
  );
}
