#!/usr/bin/env bash
# ============================================================
# Бэкап SQLite через VACUUM INTO — консистентный снимок.
# Использование:  bash scripts/backup.sh
# ============================================================

set -e
cd "$(dirname "$0")/.."

DB="data/memobred.db"
DIR="backups"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/memobred-$STAMP.db"

if [ ! -f "$DB" ]; then
  echo "❌ База не найдена: $DB"
  exit 1
fi

mkdir -p "$DIR"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" "VACUUM INTO '$OUT';"
else
  # Fallback: node + встроенный модуль
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('$DB');
    db.exec(\"VACUUM INTO '$OUT'\");
    db.close();
  "
fi

echo "✅ Бэкап: $OUT"

# Удаляем бэкапы старше 30 дней
find "$DIR" -name 'memobred-*.db' -type f -mtime +30 -delete 2>/dev/null || true