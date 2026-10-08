// Hand-rolled SVG/CSS charts: no chart dependency, server-rendered, readable without JS.
// Colours are CSS variables so they follow the theme.

const C = { p700: "var(--color-p-700)", p400: "var(--color-p-400)", p950: "var(--color-p-950)", s500: "var(--color-s-500)", r600: "var(--color-r-600)", i500: "var(--color-i-500)", faint: "var(--color-faint)", hair: "var(--color-hair)" };
export const palette = [C.p950, C.p700, C.p400, C.s500, C.i500, C.faint];

/** Vertical rounded bars. A zero value renders as a hatched "nothing yet" bar instead of vanishing. */
export function Bars({ data, format = (n: number) => String(n), height = 190, highlight }: { data: { label: string; value: number }[]; format?: (n: number) => string; height?: number; highlight?: number }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const top = highlight ?? data.reduce((b, d, i) => (d.value > data[b].value ? i : b), 0);
  return (
    <ul className="grid gap-2 sm:gap-3" style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}>
      {data.map((d, i) => (
        <li key={d.label + i} className="flex min-w-0 flex-col items-center gap-2">
          <div className="flex w-full items-end" style={{ height }} title={`${d.label}: ${format(d.value)}`}>
            <div
              className={`relative w-full rounded-lg ${d.value === 0 ? "hatch" : `grow-y ${i === top ? "bg-p-950" : "bg-p-700/85"}`}`}
              style={{ height: d.value === 0 ? 36 : `${Math.max((d.value / max) * 100, 12)}%` }}
            >
              {i === top && d.value > 0 && <span className="absolute -top-7 left-1/2 -translate-x-1/2 rounded-md bg-card px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap shadow-card">{format(d.value)}</span>}
            </div>
          </div>
          <span className="text-xs text-faint">{d.label}</span>
        </li>
      ))}
    </ul>
  );
}

export type Slice = { label: string; value: number; color?: string };
/** Donut with a centre read-out and an aligned legend. */
export function Donut({ slices, center, sub, format = (n: number) => String(n) }: { slices: Slice[]; center: string; sub?: string; format?: (n: number) => string }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const r = 62, circ = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="flex flex-col items-center gap-5">
      <svg viewBox="0 0 160 160" className="h-44 w-44 shrink-0 -rotate-90" role="img" aria-label={`${center} ${sub ?? ""}`}>
        <circle cx="80" cy="80" r={r} fill="none" stroke={C.hair} strokeWidth="22" />
        {total > 0 && slices.map((s, i) => {
          const len = (s.value / total) * circ;
          const el = <circle key={s.label} cx="80" cy="80" r={r} fill="none" stroke={s.color ?? palette[i % palette.length]} strokeWidth="22" strokeDasharray={`${Math.max(len - 2, 0)} ${circ}`} strokeDashoffset={-acc} />;
          acc += len;
          return el;
        })}
        <g transform="rotate(90 80 80)" textAnchor="middle">
          <text x="80" y="82" fontSize="21" fontWeight="650" fill="var(--color-ink)">{center}</text>
          {sub && <text x="80" y="100" fontSize="10.5" fill="var(--color-faint)">{sub}</text>}
        </g>
      </svg>
      <ul className="w-full space-y-2 text-sm">
        {slices.map((s, i) => (
          <li key={s.label} className="flex items-center gap-3">
            <span className="h-3 w-3 rounded-full" style={{ background: s.color ?? palette[i % palette.length] }} />
            <span className="text-muted">{s.label}</span>
            <span className="ml-auto font-semibold">{format(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tiny trend line with a soft fill, for KPI cards. */
export function Sparkline({ points, stroke = C.p700 }: { points: number[]; stroke?: string }) {
  if (points.length < 2) return null;
  const w = 240, h = 48, max = Math.max(...points), min = Math.min(...points), span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 6 - ((p - min) / span) * (h - 14)]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-3 h-12 w-full" aria-hidden="true">
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={stroke} opacity="0.12" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Horizontal bars with a value and optional conversion note: funnels, exposure by buyer, queues. */
export function HBars({ rows, format = (n: number) => String(n) }: { rows: { label: string; value: number; note?: string; tone?: string }[]; format?: (n: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-4">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium">{r.label}</span>
            <span className="text-muted"><b className="text-ink">{format(r.value)}</b>{r.note && <span className="ml-2 text-xs">{r.note}</span>}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-panel"><div className="grow-x h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: r.tone ?? C.p700 }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** Line chart: one or two series over shared x labels. */
export function LineChart({ labels, series, format = (n: number) => String(n) }: { labels: string[]; series: { name: string; points: number[]; color?: string; dashed?: boolean }[]; format?: (n: number) => string }) {
  const w = 420, h = 220, pl = 48, pb = 26, pt = 8;
  const max = Math.max(...series.flatMap((s) => s.points), 1);
  const x = (i: number) => pl + (i / Math.max(labels.length - 1, 1)) * (w - pl - 8);
  const y = (v: number) => pt + (1 - v / max) * (h - pt - pb);
  const ticks = [0, 0.5, 1].map((t) => max * t);
  const every = Math.ceil(labels.length / 6);
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Trend chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pl} x2={w - 8} y1={y(t)} y2={y(t)} stroke={C.hair} />
            <text x={pl - 8} y={y(t) + 4} textAnchor="end" fontSize="12" fill="var(--color-faint)">{format(t)}</text>
          </g>
        ))}
        {series.map((s, si) => {
          const d = s.points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p).toFixed(1)}`).join(" ");
          const col = s.color ?? palette[si];
          return (
            <g key={s.name}>
              {si === 0 && !s.dashed && <path d={`${d} L${x(s.points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} fill={col} opacity="0.1" />}
              <path d={d} fill="none" stroke={col} strokeWidth="2.4" strokeDasharray={s.dashed ? "4 5" : undefined} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
        {labels.map((l, i) => i % every === 0 && <text key={l + i} x={x(i)} y={h - 6} textAnchor="middle" fontSize="12" fill="var(--color-faint)">{l}</text>)}
      </svg>
      <div className="mt-2 flex gap-5 text-xs text-muted">
        {series.map((s, i) => <span key={s.name} className="flex items-center gap-2"><span className="h-0.5 w-5 rounded" style={{ background: s.color ?? palette[i], opacity: s.dashed ? 0.6 : 1 }} />{s.name}</span>)}
      </div>
    </div>
  );
}
