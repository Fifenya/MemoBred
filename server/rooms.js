import { generateCode, sanitizeName, log } from './utils.js';
import { PHASES, DEFAULTS } from './events.js';

const rooms = new Map();          // code → Room
const socketToRoom = new Map();   // socketId → code

// ============================================================
// Создание / вход / выход
// ============================================================

export function createRoom(socketId, rawName, sessionId = null) {
  const name = sanitizeName(rawName) || 'Хост';
  const code = generateCode(c => rooms.has(c));

  const room = {
    code,
    hostId: socketId,
    phase: PHASES.LOBBY,
    roundNumber: 0,
    gameId: null,
    round: null,
    players: [{
      id: socketId,
      sessionId: sessionId || socketId,
      name,
      score: 0,
      connected: true,
      disconnectedAt: null,
      joinedAt: Date.now(),
    }],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };

  rooms.set(code, room);
  socketToRoom.set(socketId, code);
  log('room', `Создана ${code} хостом «${name}»`);
  return room;
}

export function joinRoom(rawCode, socketId, rawName, sessionId = null) {
  const code = String(rawCode || '').toUpperCase().trim();
  const room = rooms.get(code);

  if (!room) return { ok: false, error: 'Комната не найдена' };
  if (room.phase !== PHASES.LOBBY) return { ok: false, error: 'Игра уже началась' };
  if (room.players.filter(p => p.connected).length >= DEFAULTS.MAX_PLAYERS) {
    return { ok: false, error: `Комната полна (${DEFAULTS.MAX_PLAYERS})` };
  }

  const name = sanitizeName(rawName) || `Игрок ${room.players.length + 1}`;
  const finalName = uniqueName(room, name);

  room.players.push({
    id: socketId,
    sessionId: sessionId || socketId,
    name: finalName,
    score: 0,
    connected: true,
    disconnectedAt: null,
    joinedAt: Date.now(),
  });
  socketToRoom.set(socketId, code);
  touch(room);

  log('room', `«${finalName}» вошёл в ${code} (${room.players.length} игроков)`);
  return { ok: true, room };
}

// ============================================================
// SOFT DISCONNECT — не удаляем игрока, только помечаем
// ============================================================

export function markDisconnected(socketId) {
  const code = socketToRoom.get(socketId);
  if (!code) return null;
  const room = rooms.get(code);
  if (!room) return null;

  socketToRoom.delete(socketId);
  const player = room.players.find(p => p.id === socketId);
  if (!player) return null;

  player.connected = false;
  player.disconnectedAt = Date.now();
  touch(room);

  log('room', `${code}: «${player.name}» отключился (grace ${DEFAULTS.DISCONNECT_GRACE / 1000}s)`);
  return room;
}

/**
 * Явный выход (кнопка «Выйти»). Удаляем сразу, без grace.
 */
export function leaveRoom(socketId) {
  const code = socketToRoom.get(socketId);
  if (!code) return null;
  socketToRoom.delete(socketId);

  const room = rooms.get(code);
  if (!room) return null;

  const player = room.players.find(p => p.id === socketId);
  const name = player?.name ?? '???';
  room.players = room.players.filter(p => p.id !== socketId);

  if (room.players.length === 0) {
    rooms.delete(code);
    log('room', `${code} удалена (пусто)`);
    return null;
  }

  if (room.hostId === socketId) {
    room.hostId = room.players[0].id;
    log('room', `${code}: хост передан «${room.players[0].name}»`);
  }

  touch(room);
  log('room', `«${name}» вышел из ${code} (${room.players.length} осталось)`);
  return room;
}

// ============================================================
// REJOIN — восстановление по sessionId
// ============================================================

export function findBySession(sessionId) {
  if (!sessionId) return null;
  for (const room of rooms.values()) {
    const player = room.players.find(p => p.sessionId === sessionId);
    if (player) return { room, player };
  }
  return null;
}

export function restorePlayer(room, player, newSocketId) {
  // Если старый сокет висел в маппинге — чистим
  if (player.id !== newSocketId) {
    socketToRoom.delete(player.id);
  }
  player.id = newSocketId;
  player.connected = true;
  player.disconnectedAt = null;
  socketToRoom.set(newSocketId, room.code);

  // Если хост вернулся, а его уже перекинули — возвращаем
  if (room.players.length && !room.players.some(p => p.connected && p.id === room.hostId)) {
    room.hostId = newSocketId;
  }

  touch(room);
  log('room', `${room.code}: «${player.name}» вернулся`);
  return room;
}

// ============================================================
// Поиск
// ============================================================

export function getRoomBySocket(socketId) {
  const code = socketToRoom.get(socketId);
  return code ? rooms.get(code) ?? null : null;
}

export function getRoomByCode(code) {
  return rooms.get(String(code || '').toUpperCase()) ?? null;
}

export function getPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId) ?? null;
}

export function isHost(room, socketId) {
  return room.hostId === socketId;
}

export function isJudge(room, socketId) {
  return room.round?.judgeId === socketId;
}

export function getPlayerBySession(room, sessionId) {
  return room.players.find(p => p.sessionId === sessionId) ?? null;
}

// ============================================================
// Мутации
// ============================================================

export function touch(room) {
  room.lastActivityAt = Date.now();
}

export function addScore(room, socketId, points) {
  const p = getPlayer(room, socketId);
  if (p) p.score += points;
  touch(room);
}

export function setPhase(room, phase) {
  room.phase = phase;
  touch(room);
}

// ============================================================
// Очистка
// ============================================================

/**
 * Удаляет давно отключённых игроков и мёртвые комнаты.
 * Вызывается по таймеру из index.js раз в 10 секунд.
 */
export function cleanupDisconnectedPlayers() {
  const now = Date.now();
  const grace = DEFAULTS.DISCONNECT_GRACE;
  let changed = [];

  for (const [code, room] of rooms) {
    const before = room.players.length;
    room.players = room.players.filter(p => {
      if (p.connected) return true;
      return (now - p.disconnectedAt) < grace;
    });

    if (room.players.length === before) continue;

    // Кто-то выпал окончательно
    if (room.players.length === 0) {
      rooms.delete(code);
      log('room', `${code} удалена (все отключились)`);
      changed.push(null);
      continue;
    }

    // Хост ушёл окончательно — передаём следующему
    const hostAlive = room.players.find(p => p.id === room.hostId && p.connected);
    if (!hostAlive) {
      const next = room.players.find(p => p.connected) || room.players[0];
      room.hostId = next.id;
      log('room', `${code}: хост передан «${next.name}»`);
    }

    touch(room);
    changed.push(room);
  }

  return changed;
}

/**
 * Удаляет комнаты, где никого нет ИЛИ давно не было активности.
 */
export function cleanupStaleRooms() {
  const now = Date.now();
  const ttl = DEFAULTS.ROOM_TTL;
  let removed = 0;

  for (const [code, room] of rooms) {
    const alive = room.players.filter(p => p.connected).length;
    const stale = now - room.lastActivityAt > ttl;
    if (alive === 0 && stale) {
      for (const p of room.players) socketToRoom.delete(p.id);
      rooms.delete(code);
      removed++;
    }
  }

  if (removed > 0) log('room', `Очистка: удалено ${removed}`);
  return removed;
}

// ============================================================
// Диагностика
// ============================================================

export function stats() {
  let totalPlayers = 0;
  let connected = 0;
  for (const room of rooms.values()) {
    totalPlayers += room.players.length;
    connected += room.players.filter(p => p.connected).length;
  }
  return { rooms: rooms.size, players: totalPlayers, connected };
}

// ============================================================
// Хелпер
// ============================================================

function uniqueName(room, base) {
  const taken = new Set(room.players.map(p => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now() % 1000}`;
}