CREATE TYPE "public"."org_role" AS ENUM('owner', 'manager', 'member');--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "logo_ref" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "apps" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "setup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "org_role" "org_role";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
-- Everyone who exists today created their company, so they are its owner.
UPDATE "users" SET "org_role" = 'owner' WHERE "business_id" IS NOT NULL;
