CREATE TABLE "offer_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"financier_id" uuid NOT NULL,
	"share_bps" integer NOT NULL,
	"advance_amount" bigint NOT NULL,
	"discount_bps" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tds_withheld" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"financier_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"repayment_id" uuid NOT NULL,
	"base" bigint NOT NULL,
	"rate_bps" integer NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bids" ADD COLUMN "share_bps" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "bids" ADD COLUMN "advance_bps" integer;--> statement-breakpoint
ALTER TABLE "financier_profiles" ADD COLUMN "tds_bps" integer;--> statement-breakpoint
ALTER TABLE "offer_shares" ADD CONSTRAINT "offer_shares_offer_id_financing_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."financing_offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_shares" ADD CONSTRAINT "offer_shares_financier_id_businesses_id_fk" FOREIGN KEY ("financier_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tds_withheld" ADD CONSTRAINT "tds_withheld_financier_id_businesses_id_fk" FOREIGN KEY ("financier_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tds_withheld" ADD CONSTRAINT "tds_withheld_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tds_withheld" ADD CONSTRAINT "tds_withheld_repayment_id_repayments_id_fk" FOREIGN KEY ("repayment_id") REFERENCES "public"."repayments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offer_share_pair" ON "offer_shares" USING btree ("offer_id","financier_id");--> statement-breakpoint
CREATE INDEX "tds_financier" ON "tds_withheld" USING btree ("financier_id","created_at");