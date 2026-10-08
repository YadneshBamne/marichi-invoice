CREATE TABLE "foreign_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"utr" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"foreign_amount" bigint NOT NULL,
	"rate_micro" bigint NOT NULL,
	"inr_amount" bigint NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "foreign_receipts_utr_unique" UNIQUE("utr")
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "tax_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "foreign_amount" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fx_rate_micro" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "shipping_bill" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "purpose_code" text;--> statement-breakpoint
ALTER TABLE "foreign_receipts" ADD CONSTRAINT "foreign_receipts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;