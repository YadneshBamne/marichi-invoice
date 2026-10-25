CREATE TABLE "financier_buyer_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"financier_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"limit" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financier_mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"min_ticket" bigint DEFAULT 0 NOT NULL,
	"max_ticket" bigint,
	"min_tenor_days" integer DEFAULT 1 NOT NULL,
	"max_tenor_days" integer DEFAULT 365 NOT NULL,
	"min_grade" text DEFAULT 'C' NOT NULL,
	"max_per_seller" bigint,
	"sectors" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_bid" boolean DEFAULT false NOT NULL,
	"auto_discount_bps" integer,
	"auto_advance_bps" integer,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financier_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"institution_type" text NOT NULL,
	"countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"regulator" text NOT NULL,
	"licence_type" text NOT NULL,
	"licence_number" text NOT NULL,
	"licence_valid_until" date,
	"licence_doc_ref" text,
	"settlement_account" text,
	"settlement_ifsc" text,
	"settlement_name" text,
	"settlement_verified" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"submitted_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "financier_buyer_limits" ADD CONSTRAINT "financier_buyer_limits_financier_id_businesses_id_fk" FOREIGN KEY ("financier_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financier_buyer_limits" ADD CONSTRAINT "financier_buyer_limits_buyer_id_businesses_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financier_mandates" ADD CONSTRAINT "financier_mandates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financier_profiles" ADD CONSTRAINT "financier_profiles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fbl_pair" ON "financier_buyer_limits" USING btree ("financier_id","buyer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fm_business" ON "financier_mandates" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fp_business" ON "financier_profiles" USING btree ("business_id");