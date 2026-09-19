ALTER TABLE "subscriptions" ADD COLUMN "last_reminder_days" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "auto_renew" boolean DEFAULT false NOT NULL;