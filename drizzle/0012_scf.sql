CREATE TABLE "scf_programmes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"requested_limit" bigint NOT NULL,
	"limit" bigint DEFAULT 0 NOT NULL,
	"discount_bps" integer,
	"advance_bps" integer,
	"status" text DEFAULT 'requested' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scf_suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"programme_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scf_programmes" ADD CONSTRAINT "scf_programmes_buyer_id_businesses_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scf_suppliers" ADD CONSTRAINT "scf_suppliers_programme_id_scf_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "public"."scf_programmes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scf_suppliers" ADD CONSTRAINT "scf_suppliers_seller_id_businesses_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scf_buyer" ON "scf_programmes" USING btree ("buyer_id") WHERE status in ('requested','active','paused');--> statement-breakpoint
CREATE UNIQUE INDEX "scf_supplier" ON "scf_suppliers" USING btree ("programme_id","seller_id");