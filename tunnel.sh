#!/usr/bin/env bash
# ============================================================
# МемоБред — Cloudflare Tunnel
# Поднимает публичный HTTPS-адрес для друзей.
# ============================================================

set -e
cd "$(dirname "$0")"

# ---------- Termux wake-lock ----------
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null || true
  trap 'termux-wake-unlock 2>/dev/null || true' EXIT
fi

# ---------- Проверка cloudflared ----------
if ! command -v cloudflared >/dev/null 2>&1; then
  cat <<'EOF'

  ❌  cloudflared не установлен

  Установи:
     pkg install cloudflared

EOF
  exit 1
fi

# ---------- Проверка локального сервера ----------
PORT="${PORT:-3000}"
if ! curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/health" 2>/dev/null | grep -q "200"; then
  cat <<EOF

  ╭────────────────────────────────────────────────────────╮
  │  ❌  Локальный сервер не отвечает                      │
  ╰────────────────────────────────────────────────────────╯

     Адрес:  http://localhost:$PORT

     Открой вторую сессию Termux (свайп слева → New session)
     и запусти там:

        cd ~/MemoBred && ./start.sh

     Потом вернись сюда и запусти tunnel.sh заново.

EOF
  exit 1
fi

# ---------- Красивый вывод ----------
show_intro() {
  clear 2>/dev/null || true
  cat <<'EOF'

  ╭────────────────────────────────────────────────────────────╮
  │                                                            │
  │   🎵   М е м о Б р е д                                     │
  │                                                            │
  │   Публичный доступ через Cloudflare Tunnel                 │
  │                                                            │
  ╰────────────────────────────────────────────────────────────╯

EOF
  echo "     ⏳  Поднимаю туннель на http://localhost:$PORT…"
  echo "     ⏱️   Обычно занимает 5–15 секунд"
  echo ""
}

show_ready() {
  local url="$1"
  echo ""
  echo "  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"
  echo "  ┃                                                       ┃"
  echo "  ┃              ✅   Т У Н Н Е Л Ь   Г О Т О В            ┃"
  echo "  ┃                                                       ┃"
  echo "  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"
  echo ""
  echo "     🔗  Ссылка для друзей:"
  echo ""
  echo "         $url"
  echo ""
  echo "  ───────────────────────────────────────────────────────"
  echo ""
  echo "     📋  Как позвать:"
  echo "         1. Открой игру у себя, создай комнату"
  echo "         2. Отправь друзьям ссылку + код комнаты"
  echo "         3. Они открывают в браузере — и играют"
  echo ""
  echo "     ⚠️   Не закрывай это окно — туннель работает, пока"
  echo "         он открыт."
  echo ""
  echo "     🛑  Ctrl+C — остановить."
  echo ""
  echo "  ───────────────────────────────────────────────────────"
  echo ""
}

show_error() {
  local msg="$1"
  echo ""
  echo "  ⚠️   $msg"
  echo ""
}

# ---------- Запуск ----------
show_intro

URL_SHOWN=0

cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate 2>&1 | \
while IFS= read -r line; do

  # --- Ловим URL туннеля ---
  if [[ "$line" == *"trycloudflare.com"* ]]; then
    url=$(echo "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)
    if [ -n "$url" ] && [ "$URL_SHOWN" = "0" ]; then
      URL_SHOWN=1
      show_ready "$url"
    fi
    continue
  fi

  # --- Ловим ошибки (ERR) ---
  if [[ "$line" == *" ERR "* ]]; then
    # убираем timestamp и уровень из начала
    clean=$(echo "$line" | sed -E 's/^[0-9T:Z.-]+ //; s/^ERR //')
    show_error "$clean"
    continue
  fi

  # --- Всё остальное — игнорируем ---
done