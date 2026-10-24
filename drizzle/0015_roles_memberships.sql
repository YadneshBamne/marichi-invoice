CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"email" text NOT NULL,
	"org_role" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"org_role" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ownership_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"summary" text NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "org_role" SET DATA TYPE text USING "org_role"::text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "dual_control" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inv_pending" ON "invitations" USING btree ("business_id","email") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "mem_user_biz" ON "memberships" USING btree ("user_id","business_id");--> statement-breakpoint
CREATE INDEX "mem_biz" ON "memberships" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "own_pending" ON "ownership_transfers" USING btree ("business_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "pa_biz" ON "pending_actions" USING btree ("business_id","status");--> statement-breakpoint
-- Data: the old two staff levels become the new roles (a manager could commit money, so approver; a member prepared work, so maker).
UPDATE "users" SET "org_role" = 'approver' WHERE "org_role" = 'manager';--> statement-breakpoint
UPDATE "users" SET "org_role" = 'maker' WHERE "org_role" = 'member';--> statement-breakpoint
-- Data: what kind of company each one is (from its owner's account type).
UPDATE "businesses" b SET "kind" = (SELECT u."role"::text FROM "users" u WHERE u."business_id" = b."id" AND u."role" IN ('seller','buyer','financier') ORDER BY (u."org_role" = 'owner') DESC NULLS LAST, u."created_at" LIMIT 1);--> statement-breakpoint
-- Data: everyone who belongs to a company gets a membership. A person with no company role predates roles and was the founder.
INSERT INTO "memberships" ("user_id", "business_id", "org_role", "suspended_at") SELECT "id", "business_id", COALESCE("org_role", 'owner'), NULL FROM "users" WHERE "business_id" IS NOT NULL ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "users" SET "org_role" = 'owner' WHERE "business_id" IS NOT NULL AND "org_role" IS NULL;--> statement-breakpoint
DROP TYPE "public"."org_role";