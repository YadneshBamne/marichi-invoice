CREATE TABLE "early_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"discount_bps" integer NOT NULL,
	"days_early" integer NOT NULL,
	"discount_amount" bigint NOT NULL,
	"net_amount" bigint NOT NULL,
	"fee_amount" bigint NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"proposed_by" uuid,
	"responded_by" uuid,
	"responded_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "early_payments" ADD CONSTRAINT "early_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_payments" ADD CONSTRAINT "early_payments_buyer_id_businesses_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_payments" ADD CONSTRAINT "early_payments_seller_id_businesses_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ep_live" ON "early_payments" USING btree ("invoice_id") WHERE status in ('proposed','accepted');