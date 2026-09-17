/* ============================================================
   МемоБред — клиент.
   playerToken в sessionStorage — уникален для каждой вкладки.
   ============================================================ */

const socket = io({
  reconnectionDelay: 500,
  reconnectionAttempts: 30,
  reconnectionDelayMax: 5000,
});

const TOKEN_KEY = 'memobred_token';
const getMyToken   = () => sessionStorage.getItem(TOKEN_KEY);
const setMyToken   = (t) => sessionStorage.setItem(TOKEN_KEY, t);
const clearMyToken = () => sessionStorage.removeItem(TOKEN_KEY);

// ---------- Состояние ----------
const S = {
  connected: false,
  reconnecting: false,
  youId: null,
  myToken: null,
  room: null,
  hand: [],
  promptOptions: [],
  prompt: null,
  combos: [],
  reveal: null,
  gameOver: null,
  progress: null,
  submitted: false,          // уже отправил в этом раунде?
  submittedCombo: null,      // какие мемы отправил (для показа)
  timerEnd: null,
  timerRemaining: 0,
  selected: [],
  toast: null,
};

const app = document.getElementById('app');
let toastTimer = null;
let timerInterval = null;

function resetGameState() {
  S.room = null;
  S.hand = [];
  S.promptOptions = [];
  S.prompt = null;
  S.combos = [];
  S.reveal = null;
  S.gameOver = null;
  S.progress = null;
  S.submitted = false;
  S.submittedCombo = null;
  S.timerEnd = null;
  S.timerRemaining = 0;
  S.selected = [];
  audio.stop();
  stopTimer();
}

function isMe(player) {
  return player?.token && player.token === S.myToken;
}

// ---------- Таймер ----------
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function runTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    if (!S.timerEnd) return;
    S.timerRemaining = Math.max(0, S.timerEnd - Date.now());
    // Перерисовываем только если мы в игровой фазе с таймером
    if (S.room && S.timerRemaining !== null) render();
  }, 500);
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

function formatTimer(ms) {
  if (!ms || ms <= 0) return '';
  const sec = Math.ceil(ms / 1000);
  return `${sec}`;
}

// ============================================================
// Socket
// ============================================================

socket.on('connect', () => {
  S.connected = true;
  S.youId = socket.id;

  const token = getMyToken();
  if (!token) {
    S.reconnecting = false;
    render();
    return;
  }

  S.myToken = token;
  S.reconnecting = true;
  render();

  socket.emit('rejoin', { token }, (res) => {
    S.reconnecting = false;

    if (res?.ok) {
      S.youId = res.youId;
      S.room = res.room;
      S.hand = res.hand ?? [];
      S.promptOptions = res.promptOptions ?? [];
      S.combos = res.combos ?? [];
      S.submitted = !!res.submitted;
      S.submittedCombo = res.submittedCombo ?? null;
      S.timerEnd = res.room?.timerEnd ?? null;
      if (S.timerEnd) runTimer();
      render();
      return;
    }

    clearMyToken();
    S.myToken = null;
    resetGameState();
    render();
  });
});

socket.on('disconnect', () => {
  S.connected = false;
  render();
});

socket.on('room_state', (room) => {
  if (room.phase === 'lobby' && S.room?.phase && S.room.phase !== 'lobby') {
    audio.stop();
    stopTimer();
  }
  S.room = room;

  if (room.timerEnd) {
    S.timerEnd = room.timerEnd;
    if (!timerInterval) runTimer();
  } else {
    S.timerEnd = null;
    S.timerRemaining = 0;
    stopTimer();
  }

  if (room.phase === 'lobby') {
    S.hand = []; S.combos = []; S.reveal = null; S.gameOver = null;
    S.promptOptions = []; S.prompt = null; S.selected = []; S.progress = null;
    S.submitted = false; S.submittedCombo = null;
  }
  render();
});

socket.on('phase_change', (data) => {
  audio.stop();
  stopTimer();
  // НЕ затираем prompt, если его не прислали
  if (data.prompt !== undefined) S.prompt = data.prompt;
  S.selected = [];
  S.submitted = false;
  S.submittedCombo = null;

  if (data.phase === 'judge_picks_prompt') {
    S.promptOptions = [];
    S.prompt = null;
  }
  if (data.phase === 'players_submit') {
    S.progress = {
      submitted: 0,
      expected: Math.max(0, (S.room?.players.filter(p => p.connected !== false).length ?? 1) - 1),
    };
  }
  if (data.phase !== 'reveal') S.reveal = null;
  if (data.phase !== 'judge_picks_winner') S.combos = [];

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

socket.on('timer_tick', ({ remaining }) => {
  S.timerRemaining = remaining;
  S.timerEnd = Date.now() + remaining;
  render();
});

socket.on('reveal', (data) => {
  S.reveal = data;
  if (data.prompt) S.prompt = data.prompt;
  render();
});

socket.on('game_over', (data) => {
  audio.stop();
  stopTimer();
  S.gameOver = data;
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

  socket.emit('create_room', { name }, (res) => {
    if (!res?.ok) return showToast(res?.error || 'Ошибка');
    S.youId = res.youId;
    S.myToken = res.token;
    setMyToken(res.token);
    S.room = res.room;
    render();
  });
}

function joinRoom() {
  const name = ($('name-input')?.value || '').trim();
  const code = ($('code-input')?.value || '').trim().toUpperCase();
  if (!name) return showToast('Введи имя');
  if (code.length !== 4) return showToast('Код — 4 буквы');

  socket.emit('join_room', { name, code }, (res) => {
    if (!res?.ok) return showToast(res?.error || 'Ошибка');
    S.youId = res.youId;
    S.myToken = res.token;
    setMyToken(res.token);
    S.room = res.room;
    render();
  });
}

function startGame() { socket.emit('start_game'); }

function leaveRoom() {
  socket.emit('leave_room');
  clearMyToken();
  S.myToken = null;
  resetGameState();
  render();
}

function pickPrompt(promptId) { socket.emit('pick_prompt', { promptId }); }

function toggleMeme(memeId) {
  if (S.submitted) return;
  const idx = S.selected.indexOf(memeId);
  if (idx >= 0) S.selected.splice(idx, 1);
  else if (S.selected.length < 2) S.selected.push(memeId);
  else showToast('Максимум 2 мема');
  render();
}

function submitCombo() {
  if (S.selected.length !== 2 || S.submitted) return;

  const memesToSend = [...S.selected];
  socket.emit('submit_combo', { memeIds: memesToSend }, (res) => {
    if (!res?.ok) return showToast(res?.error || 'Ошибка');
    // Запоминаем что отправил — показываем экран ожидания
    S.submitted = true;
    S.submittedCombo = S.hand.filter(m => memesToSend.includes(m.id));
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
  if (!S.connected) {
    app.innerHTML = `
      <div class="screen center">
        <h1 class="logo">🎵 МемоБред</h1>
        <p class="subtitle">Подключение…</p>
        <div class="spinner"></div>
      </div>
    `;
    return;
  }

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

function timerBadge() {
  if (!S.timerEnd || S.timerRemaining <= 0) return '';
  const sec = Math.ceil(S.timerRemaining / 1000);
  const cls = sec <= 5 ? 'timer urgent' : 'timer';
  return `<div class="${cls}">⏱ ${sec}</div>`;
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

      <p class="hint">Для партии нужно 2+ игрока.</p>

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
  const me = r.players.find(p => isMe(p));
  const isHost = me && me.token === r.hostToken;
  const count = r.players.filter(p => p.connected !== false).length;
  const canStart = isHost && count >= 2;
  const need = Math.max(0, 2 - count);

  app.innerHTML = `
    <div class="screen center">
      <h2>Комната</h2>
      <div class="code-display">${escapeHtml(r.code)}</div>
      <p class="subtitle">Скажи код друзьям</p>

      <div class="players">
        ${r.players.map(p => `
          <div class="player ${isMe(p) ? 'you' : ''} ${p.connected === false ? 'offline' : ''}">
            <span>${escapeHtml(p.name)}${p.connected === false ? ' <em>(отошёл)</em>' : ''}</span>
            ${p.token === r.hostToken ? '<span class="badge">хост</span>' : ''}
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
        ${timerBadge()}
        <h2>Раунд ${r.roundNumber}</h2>
        <p class="subtitle">Судья выбирает задание…</p>
        <div class="spinner"></div>
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="screen">
      ${timerBadge()}
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
    const exp = S.progress?.expected ?? Math.max(0, r.players.filter(p => p.connected !== false).length - 1);
    const pct = exp ? Math.round((sub / exp) * 100) : 0;

    app.innerHTML = `
      <div class="screen center">
        ${timerBadge()}
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

  // Уже отправил — показываем ожидание
  if (S.submitted) {
    const sub = S.progress?.submitted ?? 1;
    const exp = S.progress?.expected ?? 1;
    const pct = exp ? Math.round((sub / exp) * 100) : 0;

    app.innerHTML = `
      <div class="screen">
        ${timerBadge()}
        <div class="prompt-display">${escapeHtml(S.prompt?.text || '')}</div>

        <h2 style="color: var(--accent); margin-top: 8px">✓ Отправлено</h2>
        <p class="subtitle">Твоё комбо:</p>

        <div class="combo-memes" style="margin: 8px 0 16px">
          ${(S.submittedCombo ?? []).map(m => `
            <div class="combo-meme">${escapeHtml(m.title)}</div>
          `).join('')}
        </div>

        <div class="progress-bar">
          <div class="progress-bar-fill" style="width:${pct}%"></div>
        </div>
        <p class="counter">Ждём остальных: ${sub} / ${exp}</p>
      </div>
    `;
    return;
  }

  // Обычный выбор
  const need = 2 - S.selected.length;
  const ready = S.selected.length === 2;

  app.innerHTML = `
    <div class="screen">
      ${timerBadge()}
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
        ${timerBadge()}
        <div class="prompt-display">${escapeHtml(S.prompt?.text || '')}</div>
        <h2>Судья выбирает…</h2>
        <div class="spinner"></div>
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="screen">
      ${timerBadge()}
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