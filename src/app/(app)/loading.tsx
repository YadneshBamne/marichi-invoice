// Shown instantly while a page's data loads, in the shape of a typical page so nothing jumps when it arrives.
export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="space-y-5">
      <div className="space-y-2"><div className="skeleton h-8 w-64" /><div className="skeleton h-4 w-96 max-w-full" /></div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((n) => <div key={n} className="skeleton h-32" />)}</div>
      <div className="grid gap-4 xl:grid-cols-3"><div className="skeleton h-72 xl:col-span-2" /><div className="skeleton h-72" /></div>
    </div>
  );
}
