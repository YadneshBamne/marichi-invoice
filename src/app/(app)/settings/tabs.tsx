"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/organization", label: "Company" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/notifications", label: "Notifications" },
];

export function SettingsTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Settings sections" className="scroll-thin -mb-px flex gap-1 overflow-x-auto border-b border-hair">
      {TABS.map((t) => {
        const on = path === t.href;
        return (
          <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined}
            className={`relative px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${on ? "text-p-700" : "text-muted hover:text-ink"}`}>
            {t.label}
            <span className={`absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-p-700 transition-transform duration-200 ${on ? "scale-x-100" : "scale-x-0"}`} />
          </Link>
        );
      })}
    </nav>
  );
}
