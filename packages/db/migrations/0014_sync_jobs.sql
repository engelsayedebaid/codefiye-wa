CREATE TABLE "sync_job_chats" (
	"job_id" uuid NOT NULL,
	"jid" text NOT NULL,
	"name" text,
	"position" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_job_chats_job_id_jid_pk" PRIMARY KEY("job_id","jid")
);
--> statement-breakpoint
CREATE TABLE "sync_job_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_job_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" uuid NOT NULL,
	"level" text NOT NULL,
	"code" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"pause_reason" text,
	"chats_total" integer DEFAULT 0 NOT NULL,
	"chats_done" integer DEFAULT 0 NOT NULL,
	"chats_failed" integer DEFAULT 0 NOT NULL,
	"messages_added" integer DEFAULT 0 NOT NULL,
	"current_jid" text,
	"current_name" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sync_job_chats" ADD CONSTRAINT "sync_job_chats_job_id_sync_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_job_logs" ADD CONSTRAINT "sync_job_logs_job_id_sync_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_job_chats_job_id_status_position_index" ON "sync_job_chats" USING btree ("job_id","status","position");--> statement-breakpoint
CREATE INDEX "sync_job_logs_job_id_id_index" ON "sync_job_logs" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_jobs_active_idx" ON "sync_jobs" USING btree ("session_id") WHERE "sync_jobs"."status" in ('queued', 'running', 'paused');--> statement-breakpoint
CREATE INDEX "sync_jobs_session_id_started_at_index" ON "sync_jobs" USING btree ("session_id","started_at");