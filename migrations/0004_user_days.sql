CREATE TABLE "user_days" (
	"day" date NOT NULL,
	"user_id" bigint NOT NULL,
	CONSTRAINT "user_days_day_user_id_pk" PRIMARY KEY("day","user_id")
);
--> statement-breakpoint
ALTER TABLE "user_days" ADD CONSTRAINT "user_days_user_id_users_tg_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("tg_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Задним числом точной посуточной активности взять неоткуда, но день
-- последнего захода известен — он лучше, чем пустой отчёт в первый день.
INSERT INTO "user_days" ("day", "user_id")
SELECT (last_seen_at AT TIME ZONE 'Europe/Moscow')::date, tg_id FROM "users"
ON CONFLICT DO NOTHING;
