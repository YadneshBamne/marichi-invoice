CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"financier_id" uuid NOT NULL,
	"advance_amount" bigint NOT NULL,
	"discount_bps" integer NOT NULL,
	"fee_amount" bigint NOT NULL,
	"expected_discount" bigint NOT NULL,
	"tenor_days" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_financier_id_businesses_id_fk" FOREIGN KEY ("financier_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bid_open" ON "bids" USING btree ("invoice_id","financier_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "bid_invoice" ON "bids" USING btree ("invoice_id");