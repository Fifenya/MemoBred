/* ============================================================
   МемоБред — клиент v0.2
   + Плееры, точечное обновление таймера и прогресса
   ============================================================ */

const socket = io({
  reconnectionDelay: 500,
  reconnectionAttempts: 30,
  reconnectionDelayMax: 5000,
});

// ============================================================
// Настройки
// ============================================================

const Settings = {
  ambientOn: true,
  ambientVolume: 0.15,
  sfxVolume: 0.85,
  ambientTrack: null,
  STORAGE_KEY: 'memobred_settings',

  load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (typeof d.ambientOn === 'boolean')     this.ambientOn = d.ambientOn;
        if (typeof d.ambientVolume === 'number')  this.ambientVolume = d.ambientVolume;
        if (typeof d.sfxVolume === 'number')      this.sfxVolume = d.sfxVolume;
        if (typeof d.ambientTrack === 'string')   this.ambientTrack = d.ambientTrack;
      }
    } catch {}
  },
  save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
        ambientOn: this.ambientOn,
        ambientVolume: this.ambientVolume,
        sfxVolume: this.sfxVolume,
        ambientTrack: this.ambientTrack,
      }));
    } catch {}
  },
  reset() {
    this.ambientOn = true;
    this.ambientVolume = 0.15;
    this.sfxVolume = 0.85;
    this.ambientTrack = null;
    this.save();
  },
};
Settings.load();

// ============================================================
// Хранилище токенов
// ============================================================

const TOKEN_KEYS = {
  session:    'memobred_session',
  guestName:  'memobred_guest_name',
  playerSS:   'memobred_player_token',
  playerLS:   'memobred_player_saved',
};

function readSessionToken() { return localStorage.getItem(TOKEN_KEYS.session); }
function saveSessionToken(t) { localStorage.setItem(TOKEN_KEYS.session, t); }
function clearSessionToken()  { localStorage.removeItem(TOKEN_KEYS.session); }

function readGuestName() { return localStorage.getItem(TOKEN_KEYS.guestName); }
function saveGuestName(n) { localStorage.setItem(TOKEN_KEYS.guestName, n); }
function clearGuestName()  { localStorage.removeItem(TOKEN_KEYS.guestName); }

function readPlayerToken() {
  return sessionStorage.getItem(TOKEN_KEYS.playerSS)
      || localStorage.getItem(TOKEN_KEYS.playerLS)
      || null;
}
function savePlayerToken(t) {
  sessionStorage.setItem(TOKEN_KEYS.playerSS, t);
  localStorage.setItem(TOKEN_KEYS.playerLS, t);
}
function clearPlayerToken() {
  sessionStorage.removeItem(TOKEN_KEYS.playerSS);
  localStorage.removeItem(TOKEN_KEYS.playerLS);
}

// ============================================================
// Состояние
// ============================================================

const S = {
  connected: false,
  bootstrapping: true,
  screen: 'loading',
  authMode: 'login',
  user: null,
  isGuest: false,
  guestName: '',

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
  submitted: false,
  submittedCombo: null,
  timerEnd: null,
  timerRemaining: 0,
  selected: [],

  profile: null,
  profileGames: [],
  leaderboard: { type: 'score', entries: [] },
  leaderboardLoading: false,
  leaderboardSlide: 0,
  neonTick: 0,

  toast: null,
  authError: null,
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

function isMe(player) { return player?.token && player.token === S.myToken; }

function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }

function runTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    if (!S.timerEnd) return;
    S.timerRemaining = Math.max(0, S.timerEnd - Date.now());
    updateTimerUI();       // ← точечно, без render()
  }, 500);
}

// ============================================================
// Точечные обновления DOM (без перерисовки всего экрана)
// ============================================================

function updateTimerUI() {
  const slot = document.getElementById('timer-slot');
  if (!slot) return;

  let html = '';
  if (S.timerEnd && S.timerRemaining > 0) {
    const sec = Math.ceil(S.timerRemaining / 1000);
    const cls = sec <= 5 ? 'timer urgent' : 'timer';
    html = `<div class="${cls}">⏱ ${sec}</div>`;
  }

  if (slot.innerHTML !== html) {
    slot.innerHTML = html;
  }
}

function updateProgressUI() {
  if (!S.progress) return;
  const { submitted, expected } = S.progress;

  const fill = document.querySelector('.progress-bar-fill');
  if (fill) {
    const pct = expected ? Math.round((submitted / expected) * 100) : 0;
    fill.style.width = `${pct}%`;
  }

  document.querySelectorAll('.counter').forEach(el => {
    const t = el.textContent.trim();
    if (t.startsWith('Ждём остальных')) {
      el.textContent = `Ждём остальных: ${submitted} / ${expected}`;
    } else if (/^\d+\s*\/\s*\d+$/.test(t)) {
      el.textContent = `${submitted} / ${expected}`;
    }
  });
}

// ============================================================
// Эмбиент
// ============================================================

const ambient = {
  el: null,
  playlist: [],
  starting: false,
  fadeRaf: null,

  async loadPlaylist() {
    try {
      const res = await fetch('/sounds/playlist.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        this.playlist = data.filter(t => t && t.id && t.title);
      }
    } catch (e) {
      console.warn('[ambient] playlist не загружен:', e.message);
      this.playlist = [];
    }
    return this.playlist;
  },

  currentTrack() {
    if (!this.playlist.length) return null;
    return this.playlist.find(t => t.id === Settings.ambientTrack)
        || this.playlist[0];
  },

  init() {
    const track = this.currentTrack();
    if (!track) return;
    if (this.el && this.el.dataset.trackId === track.id) return;

    this.el = new Audio(`/sounds/${track.id}.mp3`);
    this.el.loop = true;
    this.el.volume = 0;
    this.el.preload = 'auto';
    this.el.dataset.trackId = track.id;
    console.log('[ambient] трек:', track.title, `(${track.id})`);
  },

  async start() {
    if (!Settings.ambientOn) return;
    if (this.starting) return;
    if (!this.playlist.length) return;

    this.starting = true;
    this.init();

    try {
      if (this.el && this.el.paused) {
        await this.el.play();
        console.log('[ambient] заиграл:', this.el.dataset.trackId);
      }
      this.fadeTo(Settings.ambientVolume, 1500);
    } catch (e) {
      console.warn('[ambient] play failed:', e.message);
    } finally {
      this.starting = false;
    }
  },

  stop() {
    if (!this.el) return;
    this.fadeTo(0, 400, () => { try { this.el.pause(); } catch {} });
  },

  async switchTo(trackId) {
    if (!this.playlist.some(t => t.id === trackId)) return;
    Settings.ambientTrack = trackId;
    Settings.save();

    if (this.el) {
      try { this.el.pause(); } catch {}
      this.el = null;
    }
    if (Settings.ambientOn) await this.start();
    render();
  },

  fadeTo(target, duration = 500, onDone) {
    if (!this.el) return;
    if (this.fadeRaf) cancelAnimationFrame(this.fadeRaf);
    const start = this.el.volume;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = t * (2 - t);
      this.el.volume = Math.max(0, Math.min(1, start + (target - start) * eased));
      if (t < 1) this.fadeRaf = requestAnimationFrame(step);
      else { this.fadeRaf = null; onDone?.(); }
    };
    this.fadeRaf = requestAnimationFrame(step);
  },

  setVolume(v) { if (this.el && !this.el.paused && Settings.ambientOn) this.el.volume = v; },
  setEnabled(on) { on ? this.start() : this.stop(); },
};

let userInteracted = false;
function markUserInteracted() {
  if (userInteracted) return;
  userInteracted = true;
  if (Settings.ambientOn) ambient.start();
}
['click', 'touchstart', 'keydown'].forEach(ev =>
  document.addEventListener(ev, markUserInteracted, { once: true, passive: true })
);

// ============================================================
// Игровые звуки
// ============================================================

const audio = {
  current: null, currentId: null, sequenceToken: 0,
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
    a.volume = Settings.sfxVolume;
    this.current = a; this.currentId = meme.id;
    render();
    try { await a.play(); }
    catch { this.stop(); render(); return showToast('Не удалось воспроизвести'); }
    a.addEventListener('ended', () => {
      if (token === this.sequenceToken) { this.currentId = null; this.current = null; render(); }
    }, { once: true });
  },
  async playSequence(memes) {
    this.stop();
    const token = ++this.sequenceToken;
    for (const m of memes) {
      if (token !== this.sequenceToken) return;
      if (!m?.url) continue;
      const a = new Audio(m.url);
      a.volume = Settings.sfxVolume;
      this.current = a; this.currentId = m.id;
      render();
      try { await a.play(); } catch { continue; }
      await new Promise((res) => {
        const t = setTimeout(res, 5000);
        a.addEventListener('ended', () => { clearTimeout(t); res(); }, { once: true });
      });
      await new Promise(r => setTimeout(r, 150));
    }
    if (token === this.sequenceToken) {
      this.current = null; this.currentId = null;
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

function setAuthError(msg) { S.authError = msg; render(); }

function formatDate(unixSec) {
  const d = new Date(unixSec * 1000);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ============================================================
// Socket
// ============================================================

socket.on('connect', async () => {
  S.connected = true;

  const playerToken = readPlayerToken();
  if (playerToken) {
    const ok = await new Promise((resolve) => {
      socket.emit('rejoin', { token: playerToken }, (res) => {
        if (res?.ok) {
          S.youId = res.youId;
          S.room = res.room;
          S.myToken = playerToken;
          S.hand = res.hand ?? [];
          S.promptOptions = res.promptOptions ?? [];
          S.combos = res.combos ?? [];
          S.submitted = !!res.submitted;
          S.submittedCombo = res.submittedCombo ?? null;
          S.timerEnd = res.room?.timerEnd ?? null;
          if (S.timerEnd) runTimer();
          resolve(true);
        } else {
          clearPlayerToken();
          resolve(false);
        }
      });
    });
    if (ok) {
      await tryAuthSession();
      S.bootstrapping = false;
      render();
      return;
    }
  }

  const authed = await tryAuthSession();
  if (authed) {
    S.bootstrapping = false;
    S.screen = 'main';
    render();
    return;
  }

  const guestName = readGuestName();
  if (guestName) {
    S.guestName = guestName;
    S.isGuest = true;
    S.bootstrapping = false;
    S.screen = 'main';
    render();
    return;
  }

  S.bootstrapping = false;
  S.screen = 'welcome';
  render();
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
  if (data.prompt !== undefined) S.prompt = data.prompt;
  S.selected = []; S.submitted = false; S.submittedCombo = null;

  if (data.phase === 'judge_picks_prompt') { S.promptOptions = []; S.prompt = null; }
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

socket.on('your_hand', ({ hand }) => { S.hand = hand ?? []; S.selected = []; render(); });

socket.on('submissions', (data) => {
  if (data.type === 'prompt_options') S.promptOptions = data.options ?? [];
  else if (data.type === 'combos')   S.combos = data.combos ?? [];
  render();
});

// Прогресс отправок — точечно, без перерисовки (чтобы не сбрасывать скролл)
socket.on('score_update', (data) => {
  if (data.type === 'submission_progress') {
    S.progress = { submitted: data.submitted, expected: data.expected };
    updateProgressUI();
  }
});

// Тик таймера — точечно
socket.on('timer_tick', ({ remaining }) => {
  S.timerRemaining = remaining;
  S.timerEnd = Date.now() + remaining;
  updateTimerUI();
});

socket.on('reveal', (data) => { S.reveal = data; if (data.prompt) S.prompt = data.prompt; render(); });
socket.on('game_over', (data) => { audio.stop(); stopTimer(); S.gameOver = data; render(); });
socket.on('error', ({ message }) => { if (message) showToast(message); });

// ============================================================
// Аутентификация
// ============================================================

async function tryAuthSession() {
  const token = readSessionToken();
  if (!token) return false;
  const res = await new Promise((resolve) => socket.emit('auth', { token }, resolve));
  if (res?.ok && res.user) {
    S.user = res.user;
    S.isGuest = false;
    return true;
  }
  clearSessionToken();
  return false;
}

function doRegister() {
  const username = ($('auth-username')?.value || '').trim();
  const password = $('auth-password')?.value || '';
  if (!username || !password) return setAuthError('Заполни все поля');

  socket.emit('register', { username, password }, (res) => {
    if (!res?.ok) return setAuthError(res?.error || 'Ошибка');
    saveSessionToken(res.token);
    S.user = res.user;
    S.isGuest = false;
    S.authError = null;
    S.screen = 'main';
    render();
  });
}

function doLogin() {
  const username = ($('auth-username')?.value || '').trim();
  const password = $('auth-password')?.value || '';
  if (!username || !password) return setAuthError('Заполни все поля');

  socket.emit('login', { username, password }, (res) => {
    if (!res?.ok) return setAuthError(res?.error || 'Ошибка');
    saveSessionToken(res.token);
    S.user = res.user;
    S.isGuest = false;
    S.authError = null;
    S.screen = 'main';
    render();
  });
}

function doLogout() {
  const token = readSessionToken();
  socket.emit('logout', { token }, () => {
    clearSessionToken();
    S.user = null;
    S.profile = null;
    S.screen = 'welcome';
    render();
  });
}

function confirmGuest() {
  const name = ($('guest-name')?.value || '').trim();
  if (!name) return setAuthError('Введи имя');
  if (name.length < 2) return setAuthError('Слишком короткое имя');
  if (name.length > 16) return setAuthError('Максимум 16 символов');

  saveGuestName(name);
  S.guestName = name;
  S.isGuest = true;
  S.user = null;
  S.authError = null;
  S.screen = 'main';
  render();
}

// ============================================================
// Комнаты
// ============================================================

function createRoom() {
  socket.emit('create_room', { name: S.guestName }, (res) => {
    if (!res?.ok) return showToast(res?.error || 'Ошибка');
    S.youId = res.youId;
    S.myToken = res.token;
    savePlayerToken(res.token);
    S.room = res.room;
    render();
  });
}

function joinRoom() {
  const code = ($('code-input')?.value || '').trim().toUpperCase();
  if (code.length !== 4) return showToast('Код — 4 буквы');

  socket.emit('join_room', { name: S.guestName, code }, (res) => {
    if (!res?.ok) return showToast(res?.error || 'Ошибка');
    S.youId = res.youId;
    S.myToken = res.token;
    savePlayerToken(res.token);
    S.room = res.room;
    render();
  });
}

function startGame() { socket.emit('start_game'); }

function leaveRoom() {
  socket.emit('leave_room');
  clearPlayerToken();
  S.myToken = null;
  resetGameState();
  S.screen = 'main';
  render();
}

function pickPrompt(promptId) { socket.emit('pick_prompt', { promptId }); }

function toggleMeme(memeId) {
  if (S.submitted) return;
  const idx = S.selected.indexOf(memeId);
  if (idx >= 0) S.selected.splice(idx, 1);
  else if (S.selected.length < 2) S.selected.push(memeId);
  else showToast('Максимум 2 мема');

  // Точечное обновление: переключаем класс и текст, не пересоздаём DOM
  updateHandUI();
}

// Точечное обновление руки (без перерисовки экрана — сохраняет скролл)
function updateHandUI() {
  const rows = document.querySelectorAll('.meme-row');
  if (!rows.length) return;

  S.hand.forEach((m, i) => {
    const row = rows[i];
    if (!row) return;
    if (S.selected.includes(m.id)) row.classList.add('selected');
    else row.classList.remove('selected');
  });

  const need = 2 - S.selected.length;
  const ready = S.selected.length === 2;

  document.querySelectorAll('.counter').forEach(el => {
    const t = el.textContent.trim();
    if (t.startsWith('Выбери ещё') || t.startsWith('Готово')) {
      el.textContent = ready ? 'Готово — отправляй' : `Выбери ещё ${need}`;
      el.classList.toggle('ready', ready);
    }
  });

  const submit = document.querySelector('button.primary');
  if (submit && submit.textContent.includes('Отправить')) {
    submit.disabled = !ready;
  }
}

function submitCombo() {
  if (S.selected.length !== 2 || S.submitted) return;
  const memesToSend = [...S.selected];
  socket.emit('submit_combo', { memeIds: memesToSend }, (res) => {
    if (!res?.ok) return showToast(res?.error || 'Ошибка');
    S.submitted = true;
    S.submittedCombo = S.hand.filter(m => memesToSend.includes(m.id));
    S.selected = [];
    render();
  });
}

function pickWinner(pid) { socket.emit('pick_winner', { pid }); }
function playMeme(id)    { const m = S.hand.find(x => x.id === id); if (m) audio.play(m); }
function playCombo(m)    { audio.playSequence(m); }

// ============================================================
// Профиль / рейтинг
// ============================================================

function openProfile() {
  if (!S.user) return showToast('Только для аккаунта');
  socket.emit('get_profile', {}, (res) => {
    if (!res?.ok) return showToast(res?.error);
    S.profile = res.user;
    S.profileGames = res.recentGames ?? [];
    S.screen = 'profile';
    render();
  });
}

function backFromProfile() { S.screen = 'main'; render(); }

function openLeaderboard(initialTab = 0) {
  S.screen = 'leaderboard';
  S.leaderboardSlide = initialTab;
  S.leaderboardLoading = true;
  render();
  loadLeaderboardTab(initialTab);
}

function backFromLeaderboard() { S.screen = 'main'; render(); }

function loadLeaderboardTab(idx) {
  const type = ['score', 'wins', 'winrate'][idx];
  S.leaderboardLoading = true;
  S.leaderboard.type = type;
  socket.emit('get_leaderboard', { type }, (res) => {
    S.leaderboardLoading = false;
    if (res?.ok) {
      S.leaderboard.entries = res.entries ?? [];
      S.neonTick++;
    }
    render();
  });
}

function switchLeaderboardSlide(idx) {
  if (idx === S.leaderboardSlide || idx < 0 || idx > 2) return;
  S.leaderboardSlide = idx;
  loadLeaderboardTab(idx);
  requestAnimationFrame(() => {
    const el = $('lb-scroll');
    if (el) el.scrollTo({ left: idx * el.clientWidth, behavior: 'smooth' });
  });
}

function onLeaderboardScroll(e) {
  const el = e.target;
  const w = el.clientWidth || 1;
  const idx = Math.round(el.scrollLeft / w);
  if (idx !== S.leaderboardSlide && idx >= 0 && idx <= 2) {
    S.leaderboardSlide = idx;
    loadLeaderboardTab(idx);
  }
}

// ============================================================
// Настройки — UI
// ============================================================

function openSettings() {
  const m = $('settings-modal');
  const t = $('ambient-toggle');
  const av = $('ambient-volume');
  const sv = $('sfx-volume');
  t.checked = Settings.ambientOn;
  av.value = Math.round(Settings.ambientVolume * 100);
  sv.value = Math.round(Settings.sfxVolume * 100);
  $('ambient-volume-value').textContent = `${Math.round(Settings.ambientVolume * 100)}%`;
  $('sfx-volume-value').textContent = `${Math.round(Settings.sfxVolume * 100)}%`;
  renderTrackGrid();
  m.hidden = false;
}
function closeSettings() { $('settings-modal').hidden = true; }

function renderTrackGrid() {
  const grid = $('ambient-track-grid');
  if (!grid) return;

  if (!ambient.playlist.length) {
    grid.innerHTML = `<p class="hint" style="grid-column:1/-1">Треки не найдены</p>`;
    return;
  }

  const current = ambient.currentTrack();
  grid.innerHTML = ambient.playlist.map(t => `
    <button class="track-card ${current && current.id === t.id ? 'active' : ''}"
            onclick="selectAmbientTrack('${escapeHtml(t.id)}')">
      <span class="track-title">${escapeHtml(t.title)}</span>
      ${current && current.id === t.id ? '<span class="track-mark">♪</span>' : ''}
    </button>
  `).join('');
}

function selectAmbientTrack(id) {
  ambient.switchTo(id).then(() => {
    renderTrackGrid();
  });
}

function bindSettingsUI() {
  $('settings-btn').addEventListener('click', openSettings);
  const m = $('settings-modal');
  m.querySelector('.modal-backdrop').addEventListener('click', closeSettings);
  m.querySelector('.modal-close').addEventListener('click', closeSettings);

  const t = $('ambient-toggle');
  t.addEventListener('change', () => {
    Settings.ambientOn = t.checked;
    Settings.save();
    ambient.setEnabled(Settings.ambientOn);
  });

  const av = $('ambient-volume');
  av.addEventListener('input', () => {
    Settings.ambientVolume = Number(av.value) / 100;
    $('ambient-volume-value').textContent = `${av.value}%`;
    ambient.setVolume(Settings.ambientVolume);
  });
  av.addEventListener('change', () => Settings.save());

  const sv = $('sfx-volume');
  sv.addEventListener('input', () => {
    Settings.sfxVolume = Number(sv.value) / 100;
    $('sfx-volume-value').textContent = `${sv.value}%`;
    if (audio.current) audio.current.volume = Settings.sfxVolume;
  });
  sv.addEventListener('change', () => Settings.save());

  $('settings-reset').addEventListener('click', () => {
    Settings.reset();
    t.checked = Settings.ambientOn;
    av.value = Math.round(Settings.ambientVolume * 100);
    sv.value = Math.round(Settings.sfxVolume * 100);
    $('ambient-volume-value').textContent = `${av.value}%`;
    $('sfx-volume-value').textContent = `${sv.value}%`;
    ambient.setEnabled(Settings.ambientOn);
    renderTrackGrid();
    showToast('Настройки сброшены');
  });

  renderTrackGrid();
}

function updateSettingsButton() {
  const btn = $('settings-btn');
  if (!btn) return;
  const inGame = S.room && S.room.phase !== 'lobby' && S.room.phase !== 'game_over';
  btn.hidden = !!inGame;
}

// ============================================================
// Рендер
// ============================================================

function render() {
  // Таймер обновим асинхронно — после того, как внутренний рендер установит DOM
  queueMicrotask(updateTimerUI);

  updateSettingsButton();

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

  if (S.bootstrapping) {
    app.innerHTML = `
      <div class="screen center">
        <h1 class="logo">🎵 МемоБред</h1>
        <p class="subtitle">Загрузка…</p>
        <div class="spinner"></div>
      </div>
    `;
    return;
  }

  if (!S.room) {
    switch (S.screen) {
      case 'welcome':     return renderWelcome();
      case 'auth':        return renderAuth();
      case 'guest':       return renderGuest();
      case 'profile':     return renderProfile();
      case 'leaderboard': return renderLeaderboard();
      default:            return renderMain();
    }
  }

  if (S.gameOver || S.room.phase === 'game_over') return renderGameOver();
  if (S.reveal) return renderReveal();

  switch (S.room.phase) {
    case 'lobby':              return renderLobby();
    case 'judge_picks_prompt': return renderJudgePicksPrompt();
    case 'players_submit':     return renderPlayersSubmit();
    case 'judge_picks_winner': return renderJudgePicksWinner();
    default:                   return renderLobby();
  }
}

// Возвращает только пустой слот. Наполняется через updateTimerUI().
function timerBadge() {
  return `<div id="timer-slot" class="timer-slot"></div>`;
}

// --- Плеер-«walkman» ---
function deckFront(memes, { playing = false, clickable = false, onClickJs = '', playBtnJs = '', playBtnInner = null } = {}) {
  const tapeLines = (memes ?? []).map(m => `<div class="tape-line">${escapeHtml(m.title)}</div>`).join('');
  const playInner = playBtnInner !== null ? playBtnInner : (playing ? '⏸' : '▶');
  const playBtnAttr = playBtnJs ? `onclick='event.stopPropagation(); ${playBtnJs}'` : '';
  return `
    <div class="deck-face deck-front" ${clickable ? `onclick='${onClickJs}'` : ''}>
      <div class="deck-window">
        <div class="deck-reels"><span class="reel"></span><span class="reel"></span></div>
        <div class="deck-tape">${tapeLines}</div>
      </div>
      <div class="deck-controls">
        <button class="deck-play" ${playBtnAttr} aria-label="Прослушать">${playInner}</button>
        <span class="deck-dots"><span></span><span></span><span></span></span>
      </div>
    </div>
  `;
}

// ---------- Welcome ----------
function renderWelcome() {
  app.innerHTML = `
    <div class="screen center">
      <h1 class="logo">🎵 МемоБред</h1>
      <p class="subtitle">Собери свой бред из мемов</p>

      <div class="card">
        <button class="primary" onclick="gotoAuth('login')">Войти</button>
        <button class="secondary" onclick="gotoAuth('register')">Регистрация</button>
      </div>

      <button class="ghost" onclick="gotoGuest()">Играть гостем →</button>
      <p class="hint">Аккаунт открывает статистику и рейтинг.<br>Гость играет сразу, без регистрации.</p>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

// ---------- Auth ----------
function renderAuth() {
  const isLogin = S.authMode === 'login';
  app.innerHTML = `
    <div class="screen center">
      <h1 class="logo">🎵 МемоБред</h1>
      <h2 style="margin-bottom: 6px">${isLogin ? 'Вход' : 'Регистрация'}</h2>

      <div class="card">
        <input id="auth-username" placeholder="Имя" maxlength="20" autocomplete="off" />
        <input id="auth-password" type="password" placeholder="Пароль"
               autocomplete="current-password" />
        ${S.authError ? `<div class="error">${escapeHtml(S.authError)}</div>` : ''}
        <button class="primary" onclick="${isLogin ? 'doLogin()' : 'doRegister()'}">
          ${isLogin ? 'Войти' : 'Создать аккаунт'}
        </button>
      </div>

      <button class="ghost" onclick="gotoAuth('${isLogin ? 'register' : 'login'}')">
        ${isLogin ? 'Нет аккаунта? Зарегистрируйся' : 'Уже есть аккаунт? Войти'}
      </button>
      <button class="ghost" onclick="gotoGuest()">Играть гостем</button>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;

  setTimeout(() => $('auth-username')?.focus(), 60);
  ['auth-username', 'auth-password'].forEach(id => {
    $(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { isLogin ? doLogin() : doRegister(); }
    });
  });
}

// ---------- Guest ----------
function renderGuest() {
  app.innerHTML = `
    <div class="screen center">
      <h1 class="logo">🎵 МемоБред</h1>
      <h2 style="margin-bottom: 6px">Как тебя звать?</h2>
      <p class="subtitle">Гость не сохраняет статистику</p>

      <div class="card">
        <input id="guest-name" placeholder="Имя" maxlength="16"
               autocomplete="off" value="${escapeHtml(S.guestName || '')}" />
        ${S.authError ? `<div class="error">${escapeHtml(S.authError)}</div>` : ''}
        <button class="primary" onclick="confirmGuest()">Готово</button>
      </div>

      <button class="ghost" onclick="gotoWelcome()">← Назад</button>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;

  setTimeout(() => $('guest-name')?.focus(), 60);
  $('guest-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmGuest();
  });
}

// ---------- Main ----------
function renderMain() {
  const displayName = S.user ? S.user.username : (S.guestName || 'Гость');
  const badge = S.user ? '🌟' : '·';

  app.innerHTML = `
    <div class="screen center">
      <h1 class="logo">🎵 МемоБред</h1>

      <div class="user-bar">
        <div class="user-info">
          <span class="user-badge">${badge}</span>
          <span class="user-name">${escapeHtml(displayName)}</span>
        </div>
        <div class="user-actions">
          ${S.user
            ? `<button class="icon-btn" onclick="openProfile()" title="Профиль">👤</button>`
            : `<button class="icon-btn" onclick="gotoAuth('login')" title="Войти">👤</button>`}
          <button class="icon-btn" onclick="openLeaderboard(0)" title="Рейтинг">🏆</button>
        </div>
      </div>

      <div class="card">
        <button class="primary" onclick="createRoom()">Создать комнату</button>
      </div>

      <div class="card">
        <input id="code-input" class="code-input" placeholder="КОД" maxlength="4"
               autocomplete="off" inputmode="text" />
        <button class="secondary" onclick="joinRoom()">Войти по коду</button>
      </div>

      <p class="hint">Для партии нужно 2+ игрока.</p>

      ${S.user
        ? `<button class="ghost" onclick="doLogout()">Выйти из аккаунта</button>`
        : `<button class="ghost" onclick="gotoWelcome()">Сменить имя</button>`}

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;

  $('code-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
}

// ---------- Profile ----------
function renderProfile() {
  const u = S.profile;
  if (!u) { S.screen = 'main'; return render(); }

  app.innerHTML = `
    <div class="screen">
      <div class="profile-header">
        <button class="icon-btn back" onclick="backFromProfile()">←</button>
        <h2>${escapeHtml(u.username)}</h2>
        <span></span>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">${u.games_played}</div>
          <div class="stat-label">партий</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${u.games_won}</div>
          <div class="stat-label">побед</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${u.winrate}%</div>
          <div class="stat-label">винрейт</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${u.total_score}</div>
          <div class="stat-label">очков</div>
        </div>
      </div>

      <h2 style="text-align:left; font-size:16px; margin-top:8px">Последние партии</h2>
      ${S.profileGames.length === 0
        ? '<p class="hint">Пока пусто. Сыграй партию!</p>'
        : `<div class="game-list">
            ${S.profileGames.map(g => `
              <div class="game-row ${g.won ? 'won' : ''}">
                <div class="game-place">#${g.place}</div>
                <div class="game-info">
                  <div class="game-players">${g.total_players} игроков · ${g.room_code}</div>
                  <div class="game-date">${formatDate(g.started_at)}</div>
                </div>
                <div class="game-score">${g.score}</div>
              </div>
            `).join('')}
          </div>`}

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

// ---------- Leaderboard ----------
function renderLeaderboard() {
  const tabs = ['Очки', 'Победы', 'Винрейт'];
  const entries = S.leaderboard.entries;

  app.innerHTML = `
    <div class="screen">
      <div class="profile-header">
        <button class="icon-btn back" onclick="backFromLeaderboard()">←</button>
        <h2>Рейтинг</h2>
        <span></span>
      </div>

      <div class="lb-tabs">
        ${tabs.map((t, i) => `
          <button class="lb-tab ${i === S.leaderboardSlide ? 'active' : ''}"
                  onclick="switchLeaderboardSlide(${i})">
            ${t}
          </button>
        `).join('')}
      </div>

      <div class="lb-scroll" id="lb-scroll" onscroll="onLeaderboardScroll(event)">
        <div class="lb-page">
          ${S.leaderboardLoading
            ? '<div class="spinner"></div>'
            : (entries.length === 0
                ? '<p class="hint">Пока пусто</p>'
                : `<div class="lb-list" data-tick="${S.neonTick}">
                    ${entries.map((e, i) => `
                      <div class="lb-item ${e.rank <= 3 ? 'top' + e.rank : ''}"
                           style="--i:${i}">
                        <div class="lb-rank">${e.rank}</div>
                        <div class="lb-user">${escapeHtml(e.username)}</div>
                        <div class="lb-val">${e.value}<span class="lb-unit">${escapeHtml(e.unit || '')}</span></div>
                      </div>
                    `).join('')}
                  </div>`)}
        </div>
      </div>

      <div class="lb-dots">
        ${[0,1,2].map(i => `
          <span class="lb-dot ${i === S.leaderboardSlide ? 'active' : ''}"
                onclick="switchLeaderboardSlide(${i})"></span>
        `).join('')}
      </div>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

// ============================================================
// Экраны игры
// ============================================================

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
            <span>${p.isGuest ? '·' : '🌟'} ${escapeHtml(p.name)}${p.connected === false ? ' <em>(отошёл)</em>' : ''}</span>
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
        <p class="subtitle">Ждём плееры от игроков…</p>
        <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <p class="counter">${sub} / ${exp}</p>
      </div>
    `;
    return;
  }

  if (S.submitted) {
    const sub = S.progress?.submitted ?? 1;
    const exp = S.progress?.expected ?? 1;
    const pct = exp ? Math.round((sub / exp) * 100) : 0;

    app.innerHTML = `
      <div class="screen">
        ${timerBadge()}
        <div class="prompt-display">${escapeHtml(S.prompt?.text || '')}</div>
        <h2 style="color: var(--accent); margin-top: 8px">✓ Отправлено</h2>
        <p class="subtitle">Твой плеер улетел к судье</p>

        <div class="decks">
          <div class="deck">
            ${deckFront(S.submittedCombo ?? [], { playing: false })}
            <div class="deck-face deck-back">
              <div class="deck-author">${escapeHtml(S.user?.username || S.guestName || 'Ты')}</div>
            </div>
          </div>
        </div>

        <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <p class="counter">Ждём остальных: ${sub} / ${exp}</p>
      </div>
    `;
    return;
  }

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
      <button class="primary" ${ready ? '' : 'disabled'} onclick="submitCombo()">Отправить</button>
      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

function renderJudgePicksWinner() {
  const r = S.room;
  const isJudge = r.judgeId === S.youId;

  if (!isJudge) {
    app.innerHTML = `
      <div class="screen center">
        ${timerBadge()}
        <div class="prompt-display">${escapeHtml(S.prompt?.text || '')}</div>
        <h2>Судья слушает плееры…</h2>
        <div class="spinner"></div>
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="screen">
      ${timerBadge()}
      <div class="prompt-display">${escapeHtml(S.prompt?.text || '')}</div>
      <p class="subtitle">Тапни на плеер — выберешь. ▶ — послушать.</p>

      <div class="decks">
        ${S.combos.map((c, i) => {
          const isPlaying = c.memes.some(m => audio.currentId === m.id);
          const comboJson = JSON.stringify(c.memes).replace(/'/g, '&#39;');
          return `
            <div class="deck ${isPlaying ? 'playing' : ''}"
                 onclick="pickWinner('${c.pid}')">
              ${deckFront(c.memes, {
                playing: isPlaying,
                playBtnJs: `playCombo(${comboJson})`,
              })}
              <div class="deck-face deck-back">
                <div class="deck-author">Плеер #${i + 1}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <p class="deck-hint">Тапнул на плеер — выбрал победителя</p>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

function renderReveal() {
  const r = S.reveal;

  app.innerHTML = `
    <div class="screen">
      <div class="prompt-display">${escapeHtml(r.prompt?.text || '')}</div>
      <h2>Раскрытие</h2>

      <div class="decks">
        ${r.combos.map((c, i) => {
          const isPlaying = c.memes.some(m => audio.currentId === m.id);
          const comboJson = JSON.stringify(c.memes).replace(/'/g, '&#39;');
          const flipDelay = (1.2 + i * 0.25).toFixed(2);
          return `
            <div class="deck revealed ${c.isWinner ? 'winner' : ''} ${isPlaying ? 'playing' : ''}"
                 style="--flip-delay: ${flipDelay}s">
              ${deckFront(c.memes, {
                playing: isPlaying,
                clickable: true,
                onClickJs: `playCombo(${comboJson})`,
                playBtnInner: isPlaying ? '⏸' : '▶',
                playBtnJs: `playCombo(${comboJson})`,
              })}
              <div class="deck-face deck-back">
                <div class="deck-author">${escapeHtml(c.playerName)}</div>
                ${c.isWinner ? '<div class="deck-badge">🏆</div>' : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <p class="deck-hint">Тапни на плеер — прослушать ещё раз</p>

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

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
      ${!S.user ? `<button class="secondary" onclick="gotoAuth('register')">Сохранить статистику →</button>` : ''}

      ${S.toast ? `<div class="toast">${escapeHtml(S.toast)}</div>` : ''}
    </div>
  `;
}

// ============================================================
// Навигация
// ============================================================

function gotoWelcome()  { S.screen = 'welcome'; S.authError = null; render(); }
function gotoAuth(mode) { S.screen = 'auth'; S.authMode = mode; S.authError = null; render(); }
function gotoGuest()    { S.screen = 'guest'; S.authError = null; render(); }

// ============================================================
// Экспорт + инициализация
// ============================================================

Object.assign(window, {
  gotoWelcome, gotoAuth, gotoGuest,
  doRegister, doLogin, doLogout, confirmGuest,
  createRoom, joinRoom, startGame, leaveRoom, pickPrompt,
  toggleMeme, submitCombo, pickWinner, playMeme, playCombo,
  openProfile, backFromProfile,
  openLeaderboard, backFromLeaderboard,
  switchLeaderboardSlide, onLeaderboardScroll,
  selectAmbientTrack,
});

(async () => {
  await ambient.loadPlaylist();
  bindSettingsUI();
  render();

  if (userInteracted && Settings.ambientOn) {
    ambient.start();
  }
})();