/* ============================================================
   МемоБред — клиент с авто-восстановлением сессии.
   sessionStorage — свой у каждой вкладки (не пересекаются).
   ============================================================ */

const socket = io({
  reconnectionDelay: 500,
  reconnectionAttempts: 30,
  reconnectionDelayMax: 5000,
});

// ---------- Сессия в sessionStorage ----------
const SESSION_KEY = 'memobred_session';
const ROOM_KEY    = 'memobred_room';

function getSessionId() {
  let sid = sessionStorage.getItem(SESSION_KEY);
  if (!sid) {
    sid = (crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2)));
    sessionStorage.setItem(SESSION_KEY, sid);
  }
  return sid;
}

const SESSION_ID = getSessionId();

// ---------- Состояние ----------
const S = {
  connected: false,
  reconnecting: false,
  youId: null,
  room: null,
  hand: [],
  promptOptions: [],
  prompt: null,
  combos: [],
  reveal: null,
  gameOver: null,
  progress: null,
  selected: [],
  toast: null,
};

const app = document.getElementById('app');
let toastTimer = null;

// Сброс всего игрового состояния (кроме sessionId)
function resetGameState() {
  S.room = null;
  S.hand = [];
  S.promptOptions = [];
  S.prompt = null;
  S.combos = [];
  S.reveal = null;
  S.gameOver = null;
  S.progress = null;
  S.selected = [];
  audio.stop();
}

// ============================================================
// Аудио
// ============================================================

const audio = {
  current: null,
  currentId: null,
  sequenceToken: 0,

  stop() {
    this.sequenceToken++;
    if (this.current) {
      try { this.current.pause(); this.current.currentTime = 0; } catch {}
      this.current = null;
    }
    this.currentId = null;
  },

  async play(meme) {
    if (!meme?.url) return showToast('У этого мема нет звука');
    if (this.currentId === meme.id) { this.stop(); render(); return; }

    this.stop();
    const token = this.sequenceToken;
    const a = new Audio(meme.url);
    a.volume = 0.85;
    this.current = a;
    this.currentId = meme.id;
    render();

    try { await a.play(); }
    catch { this.stop(); render(); return showToast('Не удалось воспроизвести'); }

    a.addEventListener('ended', () => {
      if (token === this.sequenceToken) {
        this.currentId = null;
        this.current = null;
        render();
      }
    }, { once: true });
  },

  async playSequence(memes) {
    this.stop();
    const token = ++this.sequenceToken;

    for (const m of memes) {
      if (token !== this.sequenceToken) return;
      if (!m?.url) continue;

      const a = new Audio(m.url);
      a.volume = 0.85;
      this.current = a;
      this.currentId = m.id;
      render();

      try { await a.play(); } catch { continue; }

      await new Promise((resolve) => {
        const t = setTimeout(resolve, 5000);
        a.addEventListener('ended', () => { clearTimeout(t); resolve(); }, { once: true });
      });
      await new Promise(r => setTimeout(r, 150));
    }

    if (token === this.sequenceToken) {
      this.current = null;
      this.currentId = null;
      render();
    }
  },
};

// ============================================================
// Утилиты
// ============================================================

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function showToast(text) {
  S.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast = null; render(); }, 3000);
  render();
}

// ============================================================
// Socket — входящие
// ============================================================

socket.on('connect', () => {
  S.connected = true;
  S.youId = socket.id;

  const savedRoom = sessionStorage.getItem(ROOM_KEY);

  // Нет сохранённой сессии — сразу показываем главный
  if (!savedRoom) {
    S.reconnecting = false;
    render();
    return;
  }

  // Есть — пытаемся восстановиться
  S.reconnecting = true;
  render();

  socket.emit('rejoin', { sessionId: SESSION_ID, code: savedRoom }, (res) => {
    S.reconnecting = false;

    if (res?.ok) {
      S.youId = res.youId;
      S.room = res.room;
      if (res.hand) S.hand = res.hand;
      if (res.promptOptions) S.promptOptions = res.promptOptions;
      render();
      return;
    }

    // --- ВОТ ФИКС: сбрасываем ВСЁ, а не только sessionStorage ---
    sessionStorage.removeItem(ROOM_KEY);
    resetGameState();
    render();
  });
});

socket.on('disconnect', () => {
  S.connected = false;
  // S.room НЕ трогаем — вдруг reconnect вернёт нас в ту же комнату
  render();
});

socket.on('room_state', (room) => {
  if (room.phase === 'lobby' && S.room?.phase && S.room.phase !== 'lobby') {
    audio.stop();
  }
  S.room = room;

  if (room.phase === 'lobby') {
    S.hand = []; S.combos = []; S.reveal = null; S.gameOver = null;
    S.promptOptions = []; S.prompt = null; S.selected = []; S.progress = null;
  }
  render();
});

socket.on('phase_change', (data) => {
  audio.stop();
  S.prompt = data.prompt ?? null;
  S.selected = [];

  if (data.phase === 'judge_picks_prompt') S.promptOptions = [];
  if (data.phase !== 'reveal') S.reveal = null;
  if (data.phase === 'players_submit') {
    S.progress = { submitted: 0, expected: Math.max(0, (S.room?.players.length ?? 1) - 1) };
  }
  render();
});

socket.on('your_hand', ({ hand }) => {
  S.hand = hand ?? [];
  S.selected = [];
  render();
});

socket.on('submissions', (data) => {
  if (data.type === 'prompt_options') S.promptOptions = data.options ?? [];
  else if (data.type === 'combos')   S.combos = data.combos ?? [];
  render();
});

socket.on('score_update', (data) => {
  if (data.type === 'submission_progress') {
    S.progress = { submitted: data.submitted, expected: data.expected };
  }
  render();
});

socket.on('reveal', (data) => {
  S.reveal = data;
  S.prompt = data.prompt ?? S.prompt;
  render();
});

socket.on('game_over', (data) => {
  audio.stop();
  S.gameOver = data;
  sessionStorage.removeItem(ROOM_KEY);
  render();
});

socket.on('error', ({ message }) => {
  if (message) showToast(message);
});

// ============================================================
// Действия
// ============================================================

function createRoom() {
  const name = ($('name-input')?.value || '').trim();
  if (!name) return showToast('Введи имя');

  socket.emit('create_room', { name, sessionId: SESSION_ID }, (res) => {
    if (!res?.ok) return showToast(res?.error || 'Ошибка');
    S.youId = res.youId;
    S.room = res.room;
    sessionStorage.setItem(ROOM_KEY, res.room.code);
    render();
  });
}

function joinRoom() {
  const name = ($('name-input')?.value || '').trim();
  const code = ($('code-input')?.value || '').trim().toUpperCase();
  if (!name) return showToast('Введи имя');
  if (code.length !== 4) return showToast('Код — 4 буквы');

  socket.emit('join_room', { name, code, sessionId: SESSION_ID }, (res) => {
    if (!res?.ok) return showToast(res?.error || 'Ошибка');
    S.youId = res.youId;
    S.room = res.room;
    sessionStorage.setItem(ROOM_KEY, res.room.code);
    render();
  });
}

function startGame() { socket.emit('start_game'); }

function leaveRoom() {
  socket.emit('leave_room');
  sessionStorage.removeItem(ROOM_KEY);
  resetGameState();
  render();
}

function pickPrompt(promptId) { socket.emit('pick_prompt', { promptId }); }

function toggleMeme(memeId) {
  const idx = S.selected.indexOf(memeId);
  if (idx >= 0) S.selected.splice(idx, 1);
  else if (S.selected.length < 2) S.selected.push(memeId);
  else showToast('Максимум 2 мема');
  render();
}

function submitCombo() {
  if (S.selected.length !== 2) return;
  socket.emit('submit_combo', { memeIds: S.selected }, (res) => {
    if (!res?.ok) return showToast(res?.error || 'Ошибка');
    S.selected = [];
    render();
  });
}

function pickWinner(pid) { socket.emit('pick_winner', { pid }); }

function playMeme(memeId) {
  const meme = S.hand.find(m => m.id === memeId);
  if (meme) audio.play(meme);
}

function playCombo(memes) { audio.playSequence(memes); }

// ============================================================
// Рендер
// ============================================================

function render() {
  // Нет соединения
  if (!S.connected) {
    app.innerHTML = `
      <div class="screen center">
        <h1 class="logo">🎵 МемоБред</h1>
        <p class="subtitle">Подключение…</p>
        <div class="spinner"></div>
        ${S.room?.code ? `<p class="hint">Восстанавливаю комнату ${escapeHtml(S.room.code)}</p>` : ''}
      </div>
    `;
    return;
  }

  // Идёт восстановление
  if (S.reconnecting) {
    app.innerHTML = `
      <div class="screen center">
        <h1 class="logo">🎵 МемоБред</h1>
        <p class="subtitle">Восстанавливаю сессию…</p>
        <div class="spinner"></div>
      </div>
    `;
    return;
  }

  if (!S.room) return renderMain();
  if (S.gameOver || S.room.phase === 'game_over') return renderGameOver();
  if (S.reveal) return renderReveal();

  switch (S.room.phase) {
    case 'lobby':               return renderLobby();
    case 'judge_picks_prompt':  return renderJudgePicksPrompt();
    case 'players_submit':      return renderPlayersSubmit();
    case 'judge_picks_winner':  return renderJudgePicksWinner();
    default:                    return renderLobby();
  }
}

// ---------- Главный ----------
function renderMain() {
  app.innerHTML = `
    <div class="screen center">
      <h1 class="logo">🎵 МемоБред</h1>
      <p class="subtitle">Собери свой бред из мемов</p>

      <div class="card">
        <input id="name-input" placeholder="Твоё имя" maxlength="16" autocomplete="off" />
        <button class="primary" onclick="createRoom()">Создать комнату</button>
      </div>

      <div class="card">
        <input id="code-input" class="code-input" placeholder="КОД" maxlength="4"
               autocomplete="off" inputmode="text" />
        <button class="secondary" onclick="joinRoom()">Войти по коду</button>
      </div>

      <p class="hint">Для партии нужно 3+ игрока.</p>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;

  setTimeout(() => $('name-input')?.focus(), 50);
  $('code-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('name-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('code-input')?.focus(); });
}

// ---------- Лобби ----------
function renderLobby() {
  const r = S.room;
  const isHost = r.hostId === S.youId;
  const count = r.players.length;
  const canStart = isHost && count >= 3;
  const need = Math.max(0, 3 - count);

  app.innerHTML = `
    <div class="screen center">
      <h2>Комната</h2>
      <div class="code-display">${escapeHtml(r.code)}</div>
      <p class="subtitle">Скажи код друзьям</p>

      <div class="players">
        ${r.players.map(p => `
          <div class="player ${p.id === S.youId ? 'you' : ''}">
            <span>${escapeHtml(p.name)}</span>
            ${p.id === r.hostId ? '<span class="badge">хост</span>' : ''}
          </div>
        `).join('')}
      </div>

      ${isHost
        ? `<button class="primary" ${canStart ? '' : 'disabled'} onclick="startGame()">
             ${canStart ? 'Начать игру' : `Нужно ещё ${need}`}
           </button>`
        : '<p class="subtitle">Ждём, когда хост начнёт…</p>'}

      <button class="ghost" onclick="leaveRoom()">Выйти</button>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

// ---------- Судья выбирает задание ----------
function renderJudgePicksPrompt() {
  const r = S.room;
  const isJudge = r.judgeId === S.youId;

  if (!isJudge) {
    app.innerHTML = `
      <div class="screen center">
        <h2>Раунд ${r.roundNumber}</h2>
        <p class="subtitle">Судья выбирает задание…</p>
        <div class="spinner"></div>
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="screen">
      <h2>Ты — судья</h2>
      <p class="subtitle">Выбери задание для этого раунда</p>

      <div class="prompt-options">
        ${S.promptOptions.map(p => `
          <button class="prompt-card" onclick="pickPrompt('${p.id}')">
            ${escapeHtml(p.text)}
          </button>
        `).join('')}
      </div>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

// ---------- Игроки отправляют ----------
function renderPlayersSubmit() {
  const r = S.room;
  const isJudge = r.judgeId === S.youId;

  if (isJudge) {
    const sub = S.progress?.submitted ?? 0;
    const exp = S.progress?.expected ?? Math.max(0, r.players.length - 1);
    const pct = exp ? Math.round((sub / exp) * 100) : 0;

    app.innerHTML = `
      <div class="screen center">
        <h2>Ты — судья</h2>
        <div class="prompt-display">${escapeHtml(S.prompt?.text || '')}</div>
        <p class="subtitle">Ждём комбо от игроков…</p>

        <div class="progress-bar">
          <div class="progress-bar-fill" style="width:${pct}%"></div>
        </div>
        <p class="counter">${sub} / ${exp}</p>
      </div>
    `;
    return;
  }

  const need = 2 - S.selected.length;
  const ready = S.selected.length === 2;

  app.innerHTML = `
    <div class="screen">
      <div class="prompt-display">${escapeHtml(S.prompt?.text || '')}</div>
      <p class="counter ${ready ? 'ready' : ''}">
        ${ready ? 'Готово — отправляй' : `Выбери ещё ${need}`}
      </p>

      <div class="hand">
        ${S.hand.map(m => {
          const selected = S.selected.includes(m.id);
          const playing = audio.currentId === m.id;
          return `
            <div class="meme-row ${selected ? 'selected' : ''}">
              <button class="play-btn ${playing ? 'playing' : ''}"
                      onclick="playMeme('${m.id}')" aria-label="Прослушать">
                ${playing ? '⏸' : '▶'}
              </button>
              <button class="meme-title" onclick="toggleMeme('${m.id}')">
                ${escapeHtml(m.title)}
              </button>
            </div>
          `;
        }).join('')}
      </div>

      <button class="primary" ${ready ? '' : 'disabled'} onclick="submitCombo()">
        Отправить
      </button>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

// ---------- Судья выбирает победителя ----------
function renderJudgePicksWinner() {
  const r = S.room;
  const isJudge = r.judgeId === S.youId;

  if (!isJudge) {
    app.innerHTML = `
      <div class="screen center">
        <div class="prompt-display">${escapeHtml(S.prompt?.text || '')}</div>
        <h2>Судья выбирает…</h2>
        <div class="spinner"></div>
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="screen">
      <div class="prompt-display">${escapeHtml(S.prompt?.text || '')}</div>
      <p class="subtitle">Послушай и выбери лучшее комбо</p>

      <div class="combos">
        ${S.combos.map((c, i) => {
          const isPlaying = c.memes.some(m => audio.currentId === m.id);
          const comboJson = JSON.stringify(c.memes).replace(/'/g, '&#39;');
          return `
            <div class="combo combo-judge">
              <div class="combo-num">КОМБО #${i + 1}</div>
              <div class="combo-memes">
                ${c.memes.map(m => `
                  <div class="combo-meme">
                    <span class="meme-label">${escapeHtml(m.title)}</span>
                  </div>
                `).join('')}
              </div>
              <div class="combo-actions">
                <button class="ghost-btn ${isPlaying ? 'playing' : ''}"
                        onclick='playCombo(${comboJson})'>
                  ${isPlaying ? '⏸ Играет…' : '▶ Послушать'}
                </button>
                <button class="primary" onclick="pickWinner('${c.pid}')">
                  Выбрать
                </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

// ---------- Раскрытие ----------
function renderReveal() {
  const r = S.reveal;
  app.innerHTML = `
    <div class="screen">
      <div class="prompt-display">${escapeHtml(r.prompt?.text || '')}</div>
      <h2>Раскрытие</h2>

      <div class="combos">
        ${r.combos.map(c => {
          const isPlaying = c.memes.some(m => audio.currentId === m.id);
          const comboJson = JSON.stringify(c.memes).replace(/'/g, '&#39;');
          return `
            <div class="combo ${c.isWinner ? 'winner' : ''}">
              <div class="combo-author">${escapeHtml(c.playerName)}</div>
              <div class="combo-memes">
                ${c.memes.map(m => `<div class="combo-meme">${escapeHtml(m.title)}</div>`).join('')}
              </div>
              <div class="combo-actions">
                <button class="ghost-btn ${isPlaying ? 'playing' : ''}"
                        onclick='playCombo(${comboJson})'>
                  ${isPlaying ? '⏸ Играет…' : '▶ Послушать'}
                </button>
              </div>
              ${c.isWinner ? '<div class="win-badge">🏆 ПОБЕДИТЕЛЬ</div>' : ''}
            </div>
          `;
        }).join('')}
      </div>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

// ---------- Финал ----------
function renderGameOver() {
  const players = [...(S.gameOver?.players ?? [])].sort((a, b) => b.score - a.score);
  const [first, ...rest] = players;

  app.innerHTML = `
    <div class="screen center">
      <h1 class="logo">🏆 Финал</h1>
      ${first ? `<p class="subtitle">Победитель: ${escapeHtml(first.name)}</p>` : ''}

      <div class="leaderboard">
        ${[first, ...rest].filter(Boolean).map((p, i) => `
          <div class="lb-row ${i === 0 ? 'first' : ''}">
            <span class="lb-place">${i + 1}</span>
            <span class="lb-name">${escapeHtml(p.name)}</span>
            <span class="lb-score">${p.score}</span>
          </div>
        `).join('')}
      </div>

      <button class="primary" onclick="location.reload()">Играть снова</button>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

// ============================================================
// Экспорт
// ============================================================

Object.assign(window, {
  createRoom, joinRoom, startGame, leaveRoom, pickPrompt,
  toggleMeme, submitCombo, pickWinner, playMeme, playCombo,
});