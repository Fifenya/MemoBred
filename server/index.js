// ============================================================
// Точка входа: Express + Socket.IO + API + аутентификация.
// ============================================================

import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EVENTS, PHASES, DEFAULTS, LEADERBOARD_TYPES } from './events.js';
import { log } from './utils.js';
import { closeDb, memesRepo, promptsRepo } from './db.js';
import { seedIfEmpty } from './seed.js';
import {
  reloadPools, getMemesCount, getPromptsCount,
  publicRoom, startGame, pickPrompt, submitCombo, pickWinner,
  handlePlayerLeave, playerView,
} from './game.js';
import {
  createRoom, joinRoom, leaveRoom,
  getRoomBySocket, getRoomByCode, isHost,
  findByToken, restorePlayer,
  markDisconnected, cleanupDisconnectedPlayers, cleanupStaleRooms,
  stats,
} from './rooms.js';
import {
  register, login, verifySession, destroySession,
  cleanupExpiredSessions,
} from './auth.js';
import {
  findById as findUserById,
  findByUsername as findUserByUsername,
  leaderboard, recentGames, totalUsers,
} from './users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR   = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MEMES_DIR  = path.join(ROOT_DIR, 'memes');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

fs.mkdirSync(MEMES_DIR, { recursive: true });
seedIfEmpty();
reloadPools();

// ============================================================
// Express
// ============================================================

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));
app.use('/memes', express.static(MEMES_DIR, {
  maxAge: '7d',
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=604800'),
}));

// ============================================================
// HTTP API
// ============================================================

app.get('/api/health', (_req, res) => {
  const s = stats();
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    rooms: s.rooms,
    players: s.players,
    connected: s.connected,
    memes: getMemesCount(),
    prompts: getPromptsCount(),
    users: totalUsers(),
  });
});

app.get('/api/stats', (_req, res) => {
  res.json({
    memes: getMemesCount(),
    prompts: getPromptsCount(),
    users: totalUsers(),
    ...stats(),
  });
});

app.get('/api/leaderboard', (req, res) => {
  const type = LEADERBOARD_TYPES.includes(req.query.type) ? req.query.type : 'score';
  res.json({ ok: true, type, entries: leaderboard(type) });
});

app.get('/api/profile/:username', (req, res) => {
  const user = findUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json({
    ok: true,
    user,
    recentGames: recentGames(user.id, 20),
  });
});

app.post('/api/memes', (req, res) => {
  const { id, title, url, category, pack } = req.body || {};
  if (!id || !title || !category) {
    return res.status(400).json({ error: 'id, title, category обязательны' });
  }
  const finalUrl = url || `/memes/${id}.mp3`;
  memesRepo.insert({ id, title, url: finalUrl, category, pack: pack || 'custom' });
  reloadPools();
  res.json({ ok: true, id, url: finalUrl });
});

app.post('/api/prompts', (req, res) => {
  const { id, text, category } = req.body || {};
  if (!id || !text) return res.status(400).json({ error: 'id и text обязательны' });
  promptsRepo.insert({ id, text, category: category || 'custom' });
  reloadPools();
  res.json({ ok: true, id });
});

// ============================================================
// HTTP + Socket.IO
// ============================================================

const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 25000,
});

// ============================================================
// Помощники
// ============================================================

/**
 * Достаёт пользователя из socket.data.user или null.
 */
function currentUser(socket) {
  return socket.data?.user ?? null;
}

/**
 * Публичное представление юзера для клиента.
 */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    games_played: u.games_played ?? 0,
    games_won: u.games_won ?? 0,
    total_score: u.total_score ?? 0,
    winrate: u.winrate ?? (u.games_played ? Math.round((u.games_won / u.games_played) * 100) : 0),
    avg_score: u.avg_score ?? (u.games_played ? Math.round(u.total_score / u.games_played) : 0),
  };
}

// ============================================================
// Socket
// ============================================================

io.on('connection', (socket) => {
  log('sock', `+ ${socket.id.slice(0, 6)}`);

  socket.data = { user: null };

  // ---------- AUTH ----------
  socket.on(EVENTS.AUTH, ({ token } = {}, cb) => {
    if (!token) {
      return cb?.({ ok: true, isGuest: true, user: null });
    }
    const user = verifySession(token);
    if (!user) {
      return cb?.({ ok: false, error: 'Сессия истекла', isGuest: true });
    }
    socket.data.user = user;
    cb?.({ ok: true, isGuest: false, user: publicUser(user) });
  });

  // ---------- REGISTER ----------
  socket.on(EVENTS.REGISTER, async ({ username, password } = {}, cb) => {
    try {
      const result = await register(username, password);
      if (!result.ok) return cb?.(result);

      const user = verifySession(result.token);
      if (user) socket.data.user = user;

      cb?.({ ok: true, token: result.token, user: publicUser(user ?? result.user) });
    } catch (e) {
      log('auth', 'register error:', e.message);
      cb?.({ ok: false, error: 'Ошибка сервера' });
    }
  });

  // ---------- LOGIN ----------
  socket.on(EVENTS.LOGIN, async ({ username, password } = {}, cb) => {
    try {
      const result = await login(username, password);
      if (!result.ok) return cb?.(result);

      const user = verifySession(result.token);
      if (user) socket.data.user = user;

      cb?.({ ok: true, token: result.token, user: publicUser(user ?? result.user) });
    } catch (e) {
      log('auth', 'login error:', e.message);
      cb?.({ ok: false, error: 'Ошибка сервера' });
    }
  });

  // ---------- LOGOUT ----------
  socket.on(EVENTS.LOGOUT, ({ token } = {}, cb) => {
    if (token) destroySession(token);
    socket.data.user = null;
    cb?.({ ok: true });
  });

  // ---------- GET_PROFILE ----------
  socket.on(EVENTS.GET_PROFILE, ({ userId } = {}, cb) => {
    const targetId = userId ?? socket.data.user?.id;
    if (!targetId) return cb?.({ ok: false, error: 'Требуется аккаунт' });

    const user = findUserById(targetId);
    if (!user) return cb?.({ ok: false, error: 'Не найден' });

    cb?.({ ok: true, user, recentGames: recentGames(targetId, 20) });
  });

  // ---------- GET_LEADERBOARD ----------
  socket.on(EVENTS.GET_LEADERBOARD, ({ type } = {}, cb) => {
    const t = LEADERBOARD_TYPES.includes(type) ? type : 'score';
    cb?.({ ok: true, type: t, entries: leaderboard(t) });
  });

  // ==========================================================
  // Комнаты
  // ==========================================================

  socket.on(EVENTS.CREATE_ROOM, ({ name } = {}, cb) => {
    try {
      const user = currentUser(socket);
      const room = createRoom(socket.id, name, user);
      socket.join(room.code);

      const token = room.players[0].token;
      cb?.({ ok: true, youId: socket.id, token, room: publicRoom(room) });
      io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));
    } catch (e) {
      log('sock', 'create_room error:', e.message);
      cb?.({ ok: false, error: 'Не удалось создать комнату' });
    }
  });

  socket.on(EVENTS.JOIN_ROOM, ({ code, name } = {}, cb) => {
    try {
      const user = currentUser(socket);
      const result = joinRoom(code, socket.id, name, user);
      if (!result.ok) return cb?.(result);

      const { room, token } = result;
      socket.join(room.code);
      cb?.({ ok: true, youId: socket.id, token, room: publicRoom(room) });
      io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));
    } catch (e) {
      log('sock', 'join_room error:', e.message);
      cb?.({ ok: false, error: 'Ошибка сервера' });
    }
  });

  socket.on(EVENTS.REJOIN, ({ token } = {}, cb) => {
    const found = findByToken(token);
    if (!found) return cb?.({ ok: false, error: 'Сессия истекла' });

    const { room, player } = found;
    restorePlayer(room, player, socket.id);
    socket.join(room.code);

    const view = playerView(room, socket.id);

    cb?.({
      ok: true,
      youId: socket.id,
      room: publicRoom(room),
      ...view,
    });

    io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));

    if (room.round?.timerEnd) {
      const remaining = Math.max(0, room.round.timerEnd - Date.now());
      socket.emit(EVENTS.TIMER_TICK, { remaining });
    }
  });

  socket.on(EVENTS.LEAVE_ROOM, () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    try { handlePlayerLeave(room, socket.id, io); } catch {}
    const updated = leaveRoom(socket.id);
    socket.leave(room.code);
    if (updated) io.to(updated.code).emit(EVENTS.ROOM_STATE, publicRoom(updated));
  });

  socket.on(EVENTS.START_GAME, () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    if (!isHost(room, socket.id)) {
      return socket.emit(EVENTS.ERROR, { message: 'Только хост может начать игру' });
    }
    if (room.phase !== PHASES.LOBBY) return;

    try {
      startGame(room, io);
    } catch (e) {
      log('sock', 'start_game error:', e.message);
      socket.emit(EVENTS.ERROR, { message: e.message });
    }
  });

  socket.on(EVENTS.PICK_PROMPT, ({ promptId } = {}) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    pickPrompt(room, socket.id, promptId, io);
  });

  socket.on(EVENTS.SUBMIT_COMBO, ({ memeIds } = {}, cb) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const result = submitCombo(room, socket.id, memeIds, io);
    cb?.(result);
  });

  socket.on(EVENTS.PICK_WINNER, ({ pid } = {}) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    pickWinner(room, socket.id, pid, io);
  });

  // ---------- Disconnect ----------
  socket.on('disconnect', (reason) => {
    log('sock', `- ${socket.id.slice(0, 6)} (${reason})`);
    const room = markDisconnected(socket.id);
    if (room) {
      io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));
    }
  });
});

// ============================================================
// Периодические задачи
// ============================================================

const fastCleanup = setInterval(() => {
  try {
    const changed = cleanupDisconnectedPlayers();
    for (const room of changed) {
      if (room) {
        try { handlePlayerLeave(room, '__expired__', io); } catch {}
        io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));
      }
    }
  } catch (e) { log('cron', 'fast cleanup error:', e.message); }
}, 10_000);

const slowCleanup = setInterval(() => {
  try { cleanupStaleRooms(); } catch (e) { log('cron', 'slow cleanup error:', e.message); }
}, 10 * 60_000);

const sessionCleanup = setInterval(() => {
  try { cleanupExpiredSessions(); } catch (e) { log('cron', 'session cleanup error:', e.message); }
}, 60 * 60_000);

// ============================================================
// Запуск
// ============================================================

httpServer.listen(PORT, HOST, () => {
  const ip = getLanIp();
  console.log([
    '',
    '  🎵  МемоБред запущен',
    `  Локально:   http://localhost:${PORT}`,
    `  По сети:    http://${ip}:${PORT}`,
    '',
    `  Мемов:      ${getMemesCount()}`,
    `  Заданий:    ${getPromptsCount()}`,
    `  Юзеров:     ${totalUsers()}`,
    `  Node:       ${process.version}`,
    '',
  ].join('\n'));
});

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ============================================================
// Graceful shutdown
// ============================================================

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('sys', `Получен ${signal}, останавливаюсь…`);

  clearInterval(fastCleanup);
  clearInterval(slowCleanup);
  clearInterval(sessionCleanup);

  io.emit(EVENTS.ERROR, { message: 'Сервер останавливается' });

  io.close(() => {
    httpServer.close(() => {
      closeDb();
      log('sys', 'Остановлен корректно');
      process.exit(0);
    });
  });

  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',  (e) => log('sys', 'uncaughtException:', e.stack || e.message));
process.on('unhandledRejection', (e) => log('sys', 'unhandledRejection:', e?.stack || e));