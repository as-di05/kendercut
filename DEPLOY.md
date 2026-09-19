# Деплой

Схема: **воркер на Render** ($7/мес) + **Postgres на Neon** и **Redis на Upstash**
(оба бесплатно). Бот работает на long polling — домен, TLS и вебхук не нужны.

Всё по шагам. Первые три шага делаются один раз, дальше деплой — это `git push`.

---

## Шаг 1. Репозиторий на GitHub

Render умеет деплоить только из git, а у проекта его пока нет.

```bash
cd ~/Desktop/film_finder

git init
git add -A
git commit -m "Кинобот: каталог, подписки, спонсорский гейт"
```

Проверьте, что `.env` не попал в коммит — в нём токен бота:

```bash
git status --porcelain | grep -c '\.env$'   # должно быть 0
```

Дальше нужен пустой **приватный** репозиторий на GitHub:
<https://github.com/new> → имя `film-finder` → **Private** → Create.

```bash
git remote add origin https://github.com/<ваш-логин>/film-finder.git
git push -u origin HEAD
```

Ветка может называться и `main`, и `master` — Render возьмёт ту, что в
репозитории по умолчанию, в `render.yaml` имя ветки намеренно не задано.

Если стоит [GitHub CLI](https://cli.github.com), то же самое одной командой:

```bash
gh repo create film-finder --private --source=. --push
```

---

## Шаг 2. Postgres на Neon

<https://neon.tech> → Sign up (через GitHub) → **Create project**.

- **Name**: `film-finder`
- **Postgres version**: 16
- **Region**: `Europe (Frankfurt)` — ближайший к СНГ

После создания Neon покажет строку подключения. Берите вариант
**Pooled connection**, он выглядит так:

```
postgresql://user:пароль@ep-xxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

Сохраните её — это `DATABASE_URL`.

> Расширения `pg_trgm` и `unaccent` бот создаёт сам первой миграцией, Neon это
> разрешает. Кодировка у Neon UTF-8 — поиск по русским названиям работает.

### Перенести то, что уже есть локально

У вас в локальной базе лежит опубликованный фильм, канал спонсора и цены
тарифов. На новой базе их не будет, если не перенести:

```bash
pg_dump --no-owner --clean --if-exists \
  "postgres://filmfinder:filmfinder@localhost:5433/filmfinder" > /tmp/ff.sql

psql "<строка подключения Neon>" -f /tmp/ff.sql
```

Делайте это **до** первого запуска бота на Render: `--clean` сносит всё, что
было в базе, и восстанавливает заново.

Проверить, что доехало:

```bash
psql "<строка подключения Neon>" -c "select count(*) from films where is_published;"
```

Если переносить нечего — пропустите: бот сам создаст схему и заведёт жанры
с тарифами при первом запуске.

---

## Шаг 3. Redis на Upstash

<https://upstash.com> → Sign up → **Create Database**.

- **Name**: `film-finder`
- **Type**: Regional
- **Region**: `eu-central-1` (Frankfurt)

На странице базы найдите блок **Connect → ioredis** или поле `UPSTASH_REDIS_URL`.
Нужна строка вида:

```
rediss://default:пароль@eu1-xxx.upstash.io:6379
```

Именно `rediss://` (с двумя `s`) — это подключение по TLS. Сохраните, это `REDIS_URL`.

---

## Шаг 4. Воркер на Render

<https://dashboard.render.com> → **New → Blueprint** → выберите репозиторий
`film-finder`. Render прочитает `render.yaml` и предложит создать воркер.

Если Blueprint не подхватился, то же самое руками:
**New → Background Worker** → репозиторий → Runtime `Node`,
Build Command `npm ci --include=dev && npm run build`, Start Command `npm start`,
Instance Type `Starter`, Region `Frankfurt`.

Затем впишите переменные окружения (**Environment** в настройках сервиса):

| Переменная | Значение |
|---|---|
| `BOT_TOKEN` | токен от [@BotFather](https://t.me/BotFather) |
| `ADMIN_IDS` | ваш telegram id ([@userinfobot](https://t.me/userinfobot)) |
| `STORAGE_CHANNEL_ID` | id канала-хранилища, с минусом и префиксом `-100` |
| `TMDB_API_KEY` | с <https://www.themoviedb.org/settings/api>, можно оставить пустым |
| `DATABASE_URL` | строка Neon из шага 2 |
| `REDIS_URL` | строка Upstash из шага 3 |

Значения возьмите из локального `.env` — они те же.

**Create** → Render соберёт и запустит.

---

## Шаг 5. Проверка

Откройте **Logs** сервиса. Должно быть примерно так:

```
postgres подключён
redis подключён
миграции применены
бот запущен  mode=polling
```

Дальше в Telegram:

1. `/start` — открылось меню.
2. Каталог — фильм на месте.
3. Админка → Каналы спонсоров — канал на месте и включён.
4. Админка → Статистика — числа считаются.

Если бот молчит, а в логах `409 Conflict` — значит он же запущен локально.
Остановите локальный: два процесса на одном токене одновременно работать
не могут.

**Остановите локальный `npm run dev` насовсем.** С этого момента боевой бот
живёт на Render, а локальный запускайте только когда правите код.

---

## Дальше: как выкатывать изменения

```bash
git add -A
git commit -m "что поменяли"
git push
```

Render увидит push и задеплоит сам. Миграции применятся при старте.

---

## Что стоит знать про бесплатные тарифы

**Upstash** — 10 000 команд в сутки на бесплатном тарифе. Одно действие
пользователя это примерно 5 команд (сессия, лимит частоты, кэш гейта), то есть
около 2000 действий в день. Для начала хватает с запасом; упрётесь — платный
тариф там от $0.2 за 100 тысяч команд.

**Neon** — 0.5 ГБ данных. Фильмы лежат в Telegram, в базе только карточки, так
что упереться сложно. Но у бесплатного тарифа есть лимит времени работы
вычислителя, а бот ходит в базу постоянно и не даёт ей заснуть. Если упрётесь —
альтернатива [Supabase](https://supabase.com) с тем же бесплатным Postgres,
либо платный Neon.

Условия у обоих меняются — перед тем как закладываться, гляньте актуальные.

**Render** — `$7/мес` за Starter. На free воркеры не запускаются вовсе, а free
web service засыпает через 15 минут простоя. Спящий бот не просто «не
отвечает»: встают фоновые задачи, и выданные фильмы не удаляются в срок — после
48 часов Telegram их уже не удалит никогда, файлы останутся у людей навсегда.

---

## Если однажды захотите свой сервер

Всё готово для Docker:

```bash
docker compose up -d --build
```

Поднимутся бот, Postgres и Redis. Бэкапы — `scripts/backup.sh` в крон.
Подробности в [README](README.md#свой-сервер-docker).
