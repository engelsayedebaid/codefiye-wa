CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"max_sessions" integer NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "qr" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "qr_updated_at" timestamp with time zone;