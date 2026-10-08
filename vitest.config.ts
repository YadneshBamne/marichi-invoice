import { defineConfig } from "vitest/config";

// Each DB test boots in-memory Postgres (a WASM heap) + runs migrations; password hashing is slow by design.
// Cap the workers and give each a bigger heap: unbounded parallel PGlite instances exhaust memory.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000, maxWorkers: 2, execArgv: ["--max-old-space-size=4096"] },
});
