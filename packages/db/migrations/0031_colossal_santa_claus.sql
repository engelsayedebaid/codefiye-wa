ALTER TABLE "users" ADD COLUMN "avatar" "bytea";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_mimetype" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_updated_at" timestamp with time zone;