CREATE TABLE "registry_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"registry" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reference" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"due_by" date,
	"filed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registry_filings" ADD CONSTRAINT "registry_filings_offer_id_financing_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."financing_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_filings" ADD CONSTRAINT "registry_filings_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "regfile_offer" ON "registry_filings" USING btree ("offer_id");