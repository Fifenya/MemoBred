#!/usr/bin/env bash
# ============================================================
# МемоБред — Cloudflare Tunnel
# Поднимает публичный HTTPS-адрес для друзей из других городов.
# Использование:  ./tunnel.sh
# ============================================================

set -e
cd "$(dirname "$0")"

# --- Termux wake-lock ---
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null || true
  trap 'termux-wake-unlock 2>/dev/null || true' EXIT
  echo "🔒 Wake-lock включён"
fi

# --- Проверка cloudflared ---
if ! command -v cloudflared >/dev/null 2>&1; then
  cat <<'EOF'
❌ cloudflared не установлен.

   Установи одной из команд:

   pkg install cloudflared

   или вручную:
   pkg install wget
   wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
   chmod +x cloudflared-linux-arm64
   mv cloudflared-linux-arm64 $PREFIX/bin/cloudflared
EOF
  exit 1
fi

# --- Проверка, что локальный сервер отвечает ---
PORT="${PORT:-3000}"
if ! curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/health" | grep -q "200"; then
  echo "❌ Локальный сервер не отвечает на http://localhost:$PORT"
  echo "   Запусти в другой сессии Termux:  cd ~/MemoBred && ./start.sh"
  exit 1
fi

echo "🚇 Поднимаю туннель на http://localhost:$PORT"
echo "   Ссылку для друзей смотри ниже. Ctrl+C — остановить."
echo ""

exec cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate