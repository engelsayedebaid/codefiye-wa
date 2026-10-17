CREATE TABLE "user_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid,
	"type" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_seconds" integer DEFAULT 0 NOT NULL,
	"page_views" integer DEFAULT 0 NOT NULL,
	"entry_path" text,
	"last_path" text,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_visits" ADD CONSTRAINT "user_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_events_user_id_created_at_index" ON "user_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_events_created_at_index" ON "user_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_events_type_created_at_index" ON "user_events" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "user_visits_user_id_last_seen_at_index" ON "user_visits" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "user_visits_started_at_index" ON "user_visits" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "user_visits_last_seen_at_index" ON "user_visits" USING btree ("last_seen_at");