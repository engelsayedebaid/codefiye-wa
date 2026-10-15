CREATE TABLE "ad_library_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"run_id" text,
	"ads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
