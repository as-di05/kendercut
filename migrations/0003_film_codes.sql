ALTER TABLE "films" ALTER COLUMN "storage_chat_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "films" ALTER COLUMN "storage_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "films" ADD COLUMN "code" text;--> statement-breakpoint
-- Уже залитым фильмам код нужен сразу: без него поиск по коду их не найдёт,
-- а уникальный индекс ниже пустые значения пропустит и проблему спрячет.
-- Берём id: он уникален, значит коды заведомо не столкнутся.
UPDATE "films" SET "code" = lpad("id"::text, 4, '0') WHERE "code" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "films_code_idx" ON "films" USING btree ("code");
