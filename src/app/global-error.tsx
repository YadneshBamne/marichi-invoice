"use client";
import "./globals.css";

// Last-resort boundary: replaces the root layout, so it carries its own <html> and needs no providers.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ maxWidth: 440, textAlign: "center" }}>
          <p className="text-xs font-semibold tracking-[.14em] text-faint uppercase">Something went wrong</p>
          <h1 className="page-title mt-2">Marichi is having trouble</h1>
          <p className="page-sub">This is a problem on our side and your data is safe. Please try again in a moment.</p>
          {error.digest && <p className="mt-4 font-mono text-xs text-muted">Reference: {error.digest}</p>}
          <button onClick={() => retry()} className="btn btn-primary mt-6">Try again</button>
        </div>
      </body>
    </html>
  );
}
