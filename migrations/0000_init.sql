-- Расширения нужны до создания GIN-индексов ниже.
-- ВАЖНО: база должна быть в UTF-8-локали, а не в C — иначе pg_trgm
-- не строит тригаммы для кириллицы и поиск по русским названиям молчит.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE TYPE "public"."broadcast_status" AS ENUM('draft', 'running', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."subscription_source" AS ENUM('payment', 'referral', 'admin', 'trial');--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "broadcast_status" DEFAULT 'draft' NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivered_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" integer NOT NULL,
	"delete_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "film_genres" (
	"film_id" integer NOT NULL,
	"genre_id" integer NOT NULL,
	CONSTRAINT "film_genres_film_id_genre_id_pk" PRIMARY KEY("film_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE "films" (
	"id" serial PRIMARY KEY NOT NULL,
	"title_ru" text NOT NULL,
	"title_orig" text,
	"year" integer,
	"description" text,
	"duration_min" integer,
	"rating" real,
	"tmdb_id" integer,
	"poster_file_id" text,
	"storage_chat_id" bigint NOT NULL,
	"storage_message_id" integer NOT NULL,
	"file_id" text,
	"file_unique_id" text,
	"file_size" bigint,
	"is_published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('russian', coalesce(title_ru, '')), 'A') || setweight(to_tsvector('simple', coalesce(title_orig, '')), 'B')) STORED
);
--> statement-breakpoint
CREATE TABLE "genres" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name_ru" text NOT NULL,
	"tmdb_id" integer,
	CONSTRAINT "genres_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"plan_id" integer,
	"subscription_id" integer,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'XTR' NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"telegram_payment_charge_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_telegram_payment_charge_id_unique" UNIQUE("telegram_payment_charge_id")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"days" integer NOT NULL,
	"price_stars" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"inviter_id" bigint NOT NULL,
	"invited_id" bigint NOT NULL,
	"bonus_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_invited_id_unique" UNIQUE("invited_id")
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint,
	"query" text NOT NULL,
	"results_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"title" text NOT NULL,
	"username" text,
	"invite_link" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"target_joins" integer,
	"joined_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sponsor_channels_chat_id_unique" UNIQUE("chat_id")
);
--> statement-breakpoint
CREATE TABLE "sponsor_passes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"channel_id" integer NOT NULL,
	"passed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"plan_id" integer,
	"source" "subscription_source" NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"tg_id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"first_name" text,
	"referrer_id" bigint,
	"is_banned" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "views" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"film_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivered_messages" ADD CONSTRAINT "delivered_messages_user_id_users_tg_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("tg_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_genres" ADD CONSTRAINT "film_genres_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_genres" ADD CONSTRAINT "film_genres_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_tg_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("tg_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviter_id_users_tg_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("tg_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_invited_id_users_tg_id_fk" FOREIGN KEY ("invited_id") REFERENCES "public"."users"("tg_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_queries" ADD CONSTRAINT "search_queries_user_id_users_tg_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("tg_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_passes" ADD CONSTRAINT "sponsor_passes_user_id_users_tg_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("tg_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_passes" ADD CONSTRAINT "sponsor_passes_channel_id_sponsor_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."sponsor_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_tg_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("tg_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_user_id_users_tg_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("tg_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivered_messages_pending_idx" ON "delivered_messages" USING btree ("delete_at") WHERE "delivered_messages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "film_genres_genre_idx" ON "film_genres" USING btree ("genre_id");--> statement-breakpoint
CREATE UNIQUE INDEX "films_storage_msg_idx" ON "films" USING btree ("storage_chat_id","storage_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "films_file_unique_idx" ON "films" USING btree ("file_unique_id");--> statement-breakpoint
CREATE INDEX "films_published_idx" ON "films" USING btree ("is_published","created_at");--> statement-breakpoint
CREATE INDEX "films_tmdb_idx" ON "films" USING btree ("tmdb_id");--> statement-breakpoint
CREATE INDEX "films_search_idx" ON "films" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "films_title_ru_trgm_idx" ON "films" USING gin (lower("title_ru") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "films_title_orig_trgm_idx" ON "films" USING gin (lower(coalesce("title_orig", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "referrals_inviter_idx" ON "referrals" USING btree ("inviter_id");--> statement-breakpoint
CREATE INDEX "search_queries_empty_idx" ON "search_queries" USING btree ("created_at") WHERE "search_queries"."results_count" = 0;--> statement-breakpoint
CREATE INDEX "sponsor_channels_active_idx" ON "sponsor_channels" USING btree ("is_active","sort");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsor_passes_user_channel_idx" ON "sponsor_passes" USING btree ("user_id","channel_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_active_idx" ON "subscriptions" USING btree ("user_id","is_active","expires_at");--> statement-breakpoint
CREATE INDEX "subscriptions_expiry_idx" ON "subscriptions" USING btree ("expires_at") WHERE "subscriptions"."is_active";--> statement-breakpoint
CREATE INDEX "users_referrer_idx" ON "users" USING btree ("referrer_id");--> statement-breakpoint
CREATE INDEX "views_film_idx" ON "views" USING btree ("film_id","created_at");--> statement-breakpoint
CREATE INDEX "views_user_idx" ON "views" USING btree ("user_id","created_at");