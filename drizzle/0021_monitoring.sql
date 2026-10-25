CREATE TABLE "sent_reminders" (
	"key" text PRIMARY KEY NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "kyb_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "aml_screened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "irn_rechecked_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "businesses" SET "kyb_approved_at" = now() WHERE "kyb_status" = 'approved';
