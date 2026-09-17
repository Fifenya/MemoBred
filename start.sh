#!/usr/bin/env bash
# ============================================================
# МемоБред — запуск сервера (Termux + Linux)
# ============================================================

set -e
cd "$(dirname "$0")"

# ---------- Termux: не даём системе убить процесс ----------
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null || true
  trap 'termux-wake-unlock 2>/dev/null || true' EXIT
  echo "🔒 Wake-lock включён (Termux)"
fi

# ---------- Проверка Node ----------
if ! command -v node >/dev/null 2>&1; then
  cat <<'EOF'
❌ Node.js не найден.

   Termux:  pkg install nodejs
   Debian:  sudo apt install nodejs npm
   Fedora:  sudo dnf install nodejs npm
   Arch:    sudo pacman -S nodejs npm
EOF
  exit 1
fi

# ---------- Проверка версии (>= 22.5 для node:sqlite) ----------
NODE_VER_RAW=$(node -v)
NODE_MAJOR=$(echo "$NODE_VER_RAW" | sed 's/^v//' | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VER_RAW" | sed 's/^v//' | cut -d. -f2)

if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  cat <<EOF
❌ Нужен Node.js >= 22.5 (для встроенного node:sqlite).
   Сейчас: $NODE_VER_RAW

   Termux:  pkg update && pkg upgrade && pkg install nodejs
EOF
  exit 1
fi

echo "📦 Node: $NODE_VER_RAW"

# ---------- Проверка встроенного node:sqlite ----------
if ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo "❌ Модуль node:sqlite недоступен. Обнови Node.js."
  exit 1
fi

# ---------- Установка зависимостей ----------
if [ ! -d node_modules ]; then
  echo "📦 Установка зависимостей…"
  npm install --no-audit --no-fund
fi

# ---------- Запуск ----------
echo "🚀 Старт сервера…"
exec env PORT="${PORT:-3000}" HOST="${HOST:-0.0.0.0}" node server/index.js