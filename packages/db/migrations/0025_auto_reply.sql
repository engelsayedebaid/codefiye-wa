CREATE TABLE "ai_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"api_key" "bytea",
	"base_url" text,
	"model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_reply_settings" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"personality" text DEFAULT 'sales' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"provider_id" text DEFAULT 'anthropic' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"fallback_provider_id" text,
	"fallback_model" text DEFAULT '' NOT NULL,
	"temperature" real DEFAULT 0.7 NOT NULL,
	"max_tokens" integer DEFAULT 800 NOT NULL,
	"delay_min_ms" integer DEFAULT 1500 NOT NULL,
	"delay_max_ms" integer DEFAULT 4000 NOT NULL,
	"business_hours_only" boolean DEFAULT false NOT NULL,
	"hours_start" integer DEFAULT 9 NOT NULL,
	"hours_end" integer DEFAULT 18 NOT NULL,
	"timezone" text DEFAULT 'Africa/Cairo' NOT NULL,
	"max_replies" integer DEFAULT 6 NOT NULL,
	"ignore_list" text[] DEFAULT '{}'::text[] NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"language" text DEFAULT 'auto' NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_reply_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auto_reply_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" bigint,
	"chat_jid" text NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'ar' NOT NULL,
	"reply" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auto_reply_settings" ADD CONSTRAINT "auto_reply_settings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_reply_settings" ADD CONSTRAINT "auto_reply_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_reply_log" ADD CONSTRAINT "auto_reply_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_reply_log" ADD CONSTRAINT "auto_reply_log_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auto_reply_log_session_id_id_index" ON "auto_reply_log" USING btree ("session_id","id");--> statement-breakpoint
CREATE INDEX "auto_reply_log_workspace_id_created_at_index" ON "auto_reply_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "auto_reply_log_status_created_at_index" ON "auto_reply_log" USING btree ("status","created_at");
