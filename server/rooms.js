// ============================================================
// Комнаты в памяти.
// Игрок может быть гостем (userId = null) или зарегистрированным.
// ============================================================

import { generateCode, sanitizeName, generateToken, log } from './utils.js';
import { PHASES, DEFAULTS } from './events.js';

const rooms = new Map();
const socketToRoom = new Map();

// ============================================================
// Создание / вход
// ============================================================

/**
 * @param {string}  socketId
 * @param {string}  rawName
 * @param {object?} user   — { id, username } если залогинен, иначе null
 */
export function createRoom(socketId, rawName, user = null) {
  const name = user ? user.username : (sanitizeName(rawName) || 'Хост');
  const code = generateCode(c => rooms.has(c));
  const token = generateToken();

  const room = {
    code,
    hostId: socketId,
    hostToken: token,
    phase: PHASES.LOBBY,
    roundNumber: 0,
    gameId: null,
    round: null,
    players: [{
      id: socketId,
      token,
      name,
      userId: user?.id ?? null,
      isGuest: !user,
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
  log('room', `Создана ${code} хостом «${name}»${user ? ` (id ${user.id})` : ' (гость)'}`);
  return room;
}

export function joinRoom(rawCode, socketId, rawName, user = null) {
  const code = String(rawCode || '').toUpperCase().trim();
  const room = rooms.get(code);

  if (!room) return { ok: false, error: 'Комната не найдена' };
  if (room.phase !== PHASES.LOBBY) return { ok: false, error: 'Игра уже началась' };
  if (room.players.filter(p => p.connected).length >= DEFAULTS.MAX_PLAYERS) {
    return { ok: false, error: `Комната полна (${DEFAULTS.MAX_PLAYERS})` };
  }

  // Зарегистрированный юзер не может зайти дважды в одну комнату
  if (user && room.players.some(p => p.userId === user.id)) {
    return { ok: false, error: 'Ты уже в этой комнате' };
  }

  const name = user ? user.username : (sanitizeName(rawName) || `Игрок ${room.players.length + 1}`);
  const finalName = uniqueName(room, name);
  const token = generateToken();

  room.players.push({
    id: socketId,
    token,
    name: finalName,
    userId: user?.id ?? null,
    isGuest: !user,
    score: 0,
    connected: true,
    disconnectedAt: null,
    joinedAt: Date.now(),
  });
  socketToRoom.set(socketId, code);
  touch(room);

  log('room', `«${finalName}» вошёл в ${code} (${room.players.length} игроков)`);
  return { ok: true, room, token };
}

// ============================================================
// SOFT DISCONNECT
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
    room.hostToken = room.players[0].token;
    log('room', `${code}: хост передан «${room.players[0].name}»`);
  }

  touch(room);
  log('room', `«${name}» вышел из ${code} (${room.players.length} осталось)`);
  return room;
}

// ============================================================
// REJOIN
// ============================================================

export function findByToken(token) {
  if (!token) return null;
  for (const room of rooms.values()) {
    const player = room.players.find(p => p.token === token);
    if (player) return { room, player };
  }
  return null;
}

export function restorePlayer(room, player, newSocketId) {
  const oldId = player.id;

  if (oldId && oldId !== newSocketId) socketToRoom.delete(oldId);

  if (room.round) {
    if (room.round.hands?.[oldId]) {
      room.round.hands[newSocketId] = room.round.hands[oldId];
      delete room.round.hands[oldId];
    }
    if (room.round.submissions?.[oldId]) {
      room.round.submissions[newSocketId] = room.round.submissions[oldId];
      delete room.round.submissions[oldId];
    }
    if (room.round.judgeId === oldId) room.round.judgeId = newSocketId;
  }

  player.id = newSocketId;
  player.connected = true;
  player.disconnectedAt = null;
  socketToRoom.set(newSocketId, room.code);

  if (room.hostToken === player.token) room.hostId = newSocketId;

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

// ============================================================
// Мутации
// ============================================================

export function touch(room) { room.lastActivityAt = Date.now(); }

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

export function cleanupDisconnectedPlayers() {
  const now = Date.now();
  const grace = DEFAULTS.DISCONNECT_GRACE;
  const changed = [];

  for (const [code, room] of rooms) {
    const before = room.players.length;
    room.players = room.players.filter(p => {
      if (p.connected) return true;
      return (now - p.disconnectedAt) < grace;
    });

    if (room.players.length === before) continue;

    if (room.players.length === 0) {
      rooms.delete(code);
      log('room', `${code} удалена (все отключились)`);
      changed.push(null);
      continue;
    }

    const hostAlive = room.players.find(p => p.id === room.hostId && p.connected);
    if (!hostAlive) {
      const next = room.players.find(p => p.connected) || room.players[0];
      room.hostId = next.id;
      room.hostToken = next.token;
      log('room', `${code}: хост передан «${next.name}»`);
    }

    touch(room);
    changed.push(room);
  }
  return changed;
}

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
  let totalPlayers = 0, connected = 0, guests = 0, registered = 0;
  for (const room of rooms.values()) {
    totalPlayers += room.players.length;
    connected += room.players.filter(p => p.connected).length;
    guests += room.players.filter(p => p.isGuest).length;
    registered += room.players.filter(p => !p.isGuest).length;
  }
  return { rooms: rooms.size, players: totalPlayers, connected, guests, registered };
}

function uniqueName(room, base) {
  const taken = new Set(room.players.map(p => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const c = `${base} ${i}`;
    if (!taken.has(c)) return c;
  }
  return `${base} ${Date.now() % 1000}`;
}