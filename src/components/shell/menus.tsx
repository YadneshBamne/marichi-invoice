"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { Icon } from "@/components/ui/icons";
import { useDropdown } from "./use-dropdown";

export type InboxItem = { id: string; subject: string; body: string; at: string };

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const ago = (iso: string) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
};

/** Icon button + anchored popover. `align` picks which edge the panel hangs from. */
function Menu({ trigger, label, tour, width = "w-72", children, dot }: { trigger: ReactNode; label: string; tour?: string; width?: string; children: (close: () => void) => ReactNode; dot?: number }) {
  const { open, setOpen, ref } = useDropdown();
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-label={label} aria-expanded={open} aria-haspopup="menu" data-tour={tour}
        className={`relative grid h-11 min-w-11 place-items-center rounded-full bg-panel text-muted transition-all duration-200 hover:bg-p-100 hover:text-p-800 active:scale-95 ${open ? "bg-p-100 text-p-800" : ""}`}>
        {trigger}
        {dot ? <span className="absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-r-600 px-1 text-[10px] leading-none font-bold text-white ring-2 ring-card">{dot > 9 ? "9+" : dot}</span> : null}
      </button>
      {open && <div role="menu" className={`anim-pop absolute right-0 z-50 mt-2 ${width} max-w-[calc(100vw-1.5rem)] rounded-panel bg-card shadow-pop`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

const row = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-panel";

export function NotificationMenu({ items }: { items: InboxItem[] }) {
  // "Unread" = newer than the last time this browser opened the bell. Delivery receipts are tracked separately.
  const [seen, setSeen] = useState<number | null>(null);
  useEffect(() => { try { setSeen(Number(localStorage.getItem("marichi:inbox-seen") ?? 0)); } catch { setSeen(0); } }, []);
  const unread = seen === null ? 0 : items.filter((i) => new Date(i.at).getTime() > seen).length;
  const markSeen = () => { try { localStorage.setItem("marichi:inbox-seen", String(Date.now())); } catch {} setSeen(Date.now()); };
  return (
    <Menu trigger={<Icon name="bell" className="h-5 w-5" />} label="Notifications" tour="notifications" width="w-[22rem]" dot={unread}>
      {(close) => (
        <div onClickCapture={() => markSeen()}>
          <div className="flex items-center justify-between px-4 py-3"><b className="text-sm">Notifications</b>{unread > 0 && <span className="text-xs text-muted">{unread} new</span>}</div>
          <ul className="scroll-thin max-h-80 divide-y divide-hair overflow-y-auto border-y border-hair">
            {items.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">You&apos;re all caught up.</li>}
            {items.map((n) => (
              <li key={n.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3"><span className="text-sm font-semibold">{n.subject}</span><span className="shrink-0 text-xs text-faint">{ago(n.at)}</span></div>
                <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{n.body}</p>
              </li>
            ))}
          </ul>
          <div className="flex justify-between p-2">
            <Link href="/notifications" onClick={close} className="rounded-lg px-3 py-2 text-sm font-semibold text-p-700 hover:bg-panel">View all</Link>
            <Link href="/settings/notifications" onClick={close} className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-panel">Preferences</Link>
          </div>
        </div>
      )}
    </Menu>
  );
}

export function HelpMenu({ staff, onTour, onShortcuts }: { staff: boolean; onTour: () => void; onShortcuts: () => void }) {
  return (
    <Menu trigger={<Icon name="help" className="h-5 w-5" />} label="Help" tour="help" width="w-64">
      {(close) => (
        <div className="p-1.5">
          <button className={row} onClick={() => { close(); onTour(); }}><Icon name="play" className="h-4 w-4 text-p-600" />Take the product tour</button>
          <Link className={row} href={staff ? "/admin/support" : "/support"} onClick={close}><Icon name="mail" className="h-4 w-4 text-p-600" />{staff ? "Support queue" : "Contact support"}</Link>
          <Link className={row} href="/grievance" onClick={close}><Icon name="flag" className="h-4 w-4 text-p-600" />Grievance redressal</Link>
          <button className={row} onClick={() => { close(); onShortcuts(); }}><Icon name="keyboard" className="h-4 w-4 text-p-600" />Keyboard shortcuts</button>
          <div className={`${row} cursor-default opacity-60 hover:bg-transparent`}><Icon name="book" className="h-4 w-4" /><span className="flex-1">Documentation</span><span className="pill bg-panel text-muted">Soon</span></div>
        </div>
      )}
    </Menu>
  );
}

export function UserMenu({ user, roleLabel, business, onTour }: { user: { name: string; email: string }; roleLabel: string; business: string | null; onTour: () => void }) {
  return (
    <Menu
      label="Account menu" tour="user-menu" width="w-72"
      trigger={<span className="flex items-center gap-3 pr-1 pl-1"><span className="grid h-9 w-9 place-items-center rounded-full bg-s-100 text-[13px] font-bold text-s-600">{initials(user.name)}</span><span className="hidden pr-3 text-left leading-tight lg:block"><span className="block text-sm font-semibold text-ink">{user.name}</span><span className="block text-xs text-muted">{roleLabel}</span></span></span>}
    >
      {(close) => (
        <div>
          <div className="border-b border-hair px-4 py-3">
            <p className="text-sm font-semibold">{user.name}</p>
            <p className="truncate text-[13px] text-muted">{user.email}</p>
            <p className="mt-2 flex items-center gap-2"><span className="pill bg-p-100 text-p-700">{roleLabel}</span>{business && <span className="truncate text-xs text-muted">{business}</span>}</p>
          </div>
          <div className="p-1.5">
            <Link className={row} href="/settings/profile" onClick={close}><Icon name="user" className="h-4 w-4 text-p-600" />Profile</Link>
            <Link className={row} href="/settings/security" onClick={close}><Icon name="lock" className="h-4 w-4 text-p-600" />Security</Link>
            <Link className={row} href="/settings/notifications" onClick={close}><Icon name="bell" className="h-4 w-4 text-p-600" />Notification settings</Link>
            <button className={row} onClick={() => { close(); onTour(); }}><Icon name="play" className="h-4 w-4 text-p-600" />Replay product tour</button>
          </div>
          <div className="border-t border-hair p-1.5">
            <button className={`${row} text-r-600`} onClick={async () => { await authClient.signOut(); window.location.href = "/login"; }}><Icon name="logout" className="h-4 w-4" />Sign out</button>
          </div>
        </div>
      )}
    </Menu>
  );
}
