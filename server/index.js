import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EVENTS, PHASES, DEFAULTS } from './events.js';
import { log } from './utils.js';
import { closeDb, memesRepo, promptsRepo } from './db.js';
import { seedIfEmpty } from './seed.js';
import { reloadPools, getMemesCount, getPromptsCount } from './game.js';
import {
  createRoom, joinRoom, leaveRoom,
  getRoomBySocket, getRoomByCode, isHost,
  findBySession, restorePlayer,
  markDisconnected, cleanupDisconnectedPlayers, cleanupStaleRooms,
  stats,
} from './rooms.js';
import {
  publicRoom, startGame, pickPrompt, submitCombo,
  pickWinner, handlePlayerLeave,
} from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR   = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MEMES_DIR  = path.join(ROOT_DIR, 'memes');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

fs.mkdirSync(MEMES_DIR, { recursive: true });
seedIfEmpty();
reloadPools();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));
app.use('/memes', express.static(MEMES_DIR, {
  maxAge: '7d',
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=604800'),
}));

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
  });
});

app.get('/api/stats', (_req, res) => {
  res.json({ memes: getMemesCount(), prompts: getPromptsCount(), ...stats() });
});

app.post('/api/memes', (req, res) => {
  const { id, title, url, category, pack } = req.body || {};
  if (!id || !title || !category) {
    return res.status(400).json({ error: 'id, title, category — обязательны' });
  }
  const finalUrl = url || `/memes/${id}.mp3`;
  memesRepo.insert({ id, title, url: finalUrl, category, pack: pack || 'custom' });
  reloadPools();
  res.json({ ok: true, id, url: finalUrl });
});

app.post('/api/prompts', (req, res) => {
  const { id, text, category } = req.body || {};
  if (!id || !text) return res.status(400).json({ error: 'id и text — обязательны' });
  promptsRepo.insert({ id, text, category: category || 'custom' });
  reloadPools();
  res.json({ ok: true, id });
});

const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 30000,     // увеличили с 20 до 30 сек
  pingInterval: 25000,
});

// ============================================================
// Socket-хендлеры
// ============================================================

io.on('connection', (socket) => {
  log('sock', `+ ${socket.id.slice(0, 6)}`);

  // ---------- Создание комнаты ----------
  socket.on(EVENTS.CREATE_ROOM, ({ name, sessionId } = {}, cb) => {
    try {
      const room = createRoom(socket.id, name, sessionId);
      socket.join(room.code);
      cb?.({ ok: true, youId: socket.id, room: publicRoom(room) });
      io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));
    } catch (e) {
      log('sock', 'create_room error:', e.message);
      cb?.({ ok: false, error: 'Не удалось создать комнату' });
    }
  });

  // ---------- Вход в комнату ----------
  socket.on(EVENTS.JOIN_ROOM, ({ code, name, sessionId } = {}, cb) => {
    const result = joinRoom(code, socket.id, name, sessionId);
    if (!result.ok) return cb?.({ ok: false, error: result.error });

    const room = result.room;
    socket.join(room.code);
    cb?.({ ok: true, youId: socket.id, room: publicRoom(room) });
    io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));
  });

  // ---------- REJOIN после reconnect ----------
  socket.on(EVENTS.REJOIN, ({ sessionId, code } = {}, cb) => {
    const found = findBySession(sessionId);
    if (!found) {
      return cb?.({ ok: false, error: 'Сессия истекла' });
    }
    const { room, player } = found;
    if (code && room.code !== String(code).toUpperCase()) {
      return cb?.({ ok: false, error: 'Код не совпадает' });
    }

    restorePlayer(room, player, socket.id);
    socket.join(room.code);

    // Приватное состояние — то, что игрок должен видеть
    const hand = room.round?.hands?.[socket.id] ?? null;
    const isJudgeNow = room.round?.judgeId === socket.id;
    const promptOptions = isJudgeNow ? room.round.promptOptions : null;

    cb?.({
      ok: true,
      youId: socket.id,
      room: publicRoom(room),
      hand,
      promptOptions,
    });

    io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));
  });

  // ---------- Явный выход ----------
  socket.on(EVENTS.LEAVE_ROOM, () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    try { handlePlayerLeave(room, socket.id, io); } catch {}
    const updated = leaveRoom(socket.id);
    socket.leave(room.code);
    if (updated) io.to(updated.code).emit(EVENTS.ROOM_STATE, publicRoom(updated));
  });

  // ---------- Старт партии ----------
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

  // ---------- Дисконнект — ТОЛЬКО помечаем ----------
  socket.on('disconnect', (reason) => {
    log('sock', `- ${socket.id.slice(0, 6)} (${reason})`);
    const room = markDisconnected(socket.id);
    if (room) {
      // Уведомляем остальных, что кто-то отключился (но не удаляем)
      io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));
    }
  });
});

// ============================================================
// Периодический cleanup
// ============================================================

// Быстрый — каждые 10 сек убирает тех, кто не вернулся
const fastCleanup = setInterval(() => {
  try {
    const changed = cleanupDisconnectedPlayers();
    for (const room of changed) {
      if (room) {
        // Если партия активна и ушёл кто-то важный — пересчитаем
        try { handlePlayerLeave(room, '__expired__', io); } catch {}
        io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));
      }
    }
  } catch (e) {
    log('cron', 'fast cleanup error:', e.message);
  }
}, 10_000);

// Медленный — раз в 10 минут убирает давно пустые комнаты
const slowCleanup = setInterval(() => {
  try { cleanupStaleRooms(); } catch (e) { log('cron', 'slow cleanup error:', e.message); }
}, 10 * 60_000);

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