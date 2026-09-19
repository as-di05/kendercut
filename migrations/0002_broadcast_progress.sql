ALTER TABLE "broadcasts" ADD COLUMN "total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "last_user_id" bigint;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "finished_at" timestamp with time zone;