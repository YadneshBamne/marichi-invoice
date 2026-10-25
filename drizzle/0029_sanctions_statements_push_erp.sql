CREATE TABLE "business_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_id" uuid NOT NULL,
	"on" date NOT NULL,
	"narration" text NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"balance" bigint
);
--> statement-breakpoint
CREATE TABLE "business_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"document_ref" text NOT NULL,
	"file_name" text NOT NULL,
	"bank_name" text,
	"account_last4" text,
	"period_from" date,
	"period_to" date,
	"status" text DEFAULT 'parsed' NOT NULL,
	"failure" text,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_org" text,
	"refresh_token" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"connected_by" uuid NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "sanctions_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"norm" text NOT NULL,
	"kind" text NOT NULL,
	"is_alias" boolean DEFAULT false NOT NULL,
	"program" text,
	"country" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanctions_loads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list" text NOT NULL,
	"source_url" text NOT NULL,
	"sha256" text NOT NULL,
	"entries" integer NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_statement_lines" ADD CONSTRAINT "business_statement_lines_statement_id_business_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."business_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_statements" ADD CONSTRAINT "business_statements_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_connections" ADD CONSTRAINT "erp_connections_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "statement_lines_statement" ON "business_statement_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "statements_business" ON "business_statements" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_conn_biz_provider" ON "erp_connections" USING btree ("business_id","provider");--> statement-breakpoint
CREATE INDEX "push_user" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sanctions_list" ON "sanctions_entries" USING btree ("list");--> statement-breakpoint
CREATE INDEX "sanctions_norm" ON "sanctions_entries" USING btree ("norm");--> statement-breakpoint
CREATE INDEX "sanctions_loads_list" ON "sanctions_loads" USING btree ("list","loaded_at");