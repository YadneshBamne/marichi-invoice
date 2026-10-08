CREATE TABLE "fraud_scans" (
	"invoice_id" uuid PRIMARY KEY NOT NULL,
	"score" integer NOT NULL,
	"signals" jsonb NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fraud_scans" ADD CONSTRAINT "fraud_scans_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;