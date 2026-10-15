CREATE TABLE "ad_library_saves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"ad" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_library_saves" ADD CONSTRAINT "ad_library_saves_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_library_saves_workspace_id_platform_external_id_index" ON "ad_library_saves" USING btree ("workspace_id","platform","external_id");--> statement-breakpoint
CREATE INDEX "ad_library_saves_workspace_id_created_at_index" ON "ad_library_saves" USING btree ("workspace_id","created_at");