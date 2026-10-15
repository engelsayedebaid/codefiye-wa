ALTER TABLE "login_attempts" DROP CONSTRAINT "login_attempts_approval_check";--> statement-breakpoint
DROP INDEX "login_attempts_user_id_approval_index";--> statement-breakpoint
CREATE INDEX "login_attempts_user_id_index" ON "login_attempts" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "login_attempts" DROP COLUMN "approval";--> statement-breakpoint
ALTER TABLE "login_attempts" DROP COLUMN "decided_by";--> statement-breakpoint
ALTER TABLE "login_attempts" DROP COLUMN "decided_at";