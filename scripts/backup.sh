#!/usr/bin/env bash
# Бэкап базы. Кладём рядом с собой, держим последние 14 штук.
#
# Крон на VPS:
#   0 4 * * * /opt/film-finder/scripts/backup.sh >> /var/log/film-finder-backup.log 2>&1
set -euo pipefail

DIR="${BACKUP_DIR:-/var/backups/film-finder}"
KEEP="${BACKUP_KEEP:-14}"
URL="${DATABASE_URL:?нужен DATABASE_URL}"

mkdir -p "$DIR"
FILE="$DIR/filmfinder-$(date +%Y%m%d-%H%M%S).sql.gz"

# --clean --if-exists: дамп сам сносит старые объекты, восстановление
# не требует пустой базы.
pg_dump --clean --if-exists --no-owner "$URL" | gzip -9 > "$FILE"

# Пустой или обрезанный файл хуже отсутствующего: он выглядит как бэкап.
if [ ! -s "$FILE" ] || ! gzip -t "$FILE"; then
  echo "бэкап битый, удаляю: $FILE" >&2
  rm -f "$FILE"
  exit 1
fi

echo "готово: $FILE ($(du -h "$FILE" | cut -f1))"

# Чистим старьё, оставляя последние $KEEP.
ls -1t "$DIR"/filmfinder-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm --
