ALTER TABLE "message_templates" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "message_templates" ADD COLUMN "buttons" text[];--> statement-breakpoint
ALTER TABLE "message_templates" ADD COLUMN "buttons_title" text;