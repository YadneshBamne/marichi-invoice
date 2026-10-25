ALTER TABLE "financier_profiles" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "financier_profiles" ADD COLUMN "terms_hash" text;--> statement-breakpoint
ALTER TABLE "financier_profiles" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "financier_profiles" ADD COLUMN "terms_accepted_by" uuid;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "record_ref" text;--> statement-breakpoint
ALTER TABLE "invoice_confirmations" ADD COLUMN "record_hash" text;--> statement-breakpoint
ALTER TABLE "scf_programmes" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "scf_programmes" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scf_programmes" ADD COLUMN "terms_accepted_by" uuid;--> statement-breakpoint
ALTER TABLE "scf_suppliers" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "scf_suppliers" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp with time zone;