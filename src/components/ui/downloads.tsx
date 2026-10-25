import { Icon } from "./icons";

/** The three ways to take a report away. The route behind `href` understands ?format=csv|xlsx|pdf. */
export function Downloads({ href, label = "", small = true }: { href: string; label?: string; small?: boolean }) {
  const join = href.includes("?") ? "&" : "?", cls = `btn btn-ghost ${small ? "btn-sm" : ""}`;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {([["CSV", "csv"], ["Excel", "xlsx"], ["PDF", "pdf"]] as const).map(([name, f]) => (
        <a key={f} className={cls} href={`${href}${join}format=${f}`}><Icon name="download" className="h-4 w-4" />{label ? `${label} ` : ""}{name}</a>
      ))}
    </span>
  );
}
