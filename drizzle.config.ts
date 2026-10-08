import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  // Migrations need a direct (non-pooled) connection; fall back to DATABASE_URL for plain Postgres.
  dbCredentials: { url: (process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL)! },
});
