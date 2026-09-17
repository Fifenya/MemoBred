// ============================================================
// Комнаты в памяти.
// Живут, пока есть хоть один подключённый игрок.
// Пустые удаляются автоматически (см. cleanup).
// ============================================================

import { generateCode, sanitizeName, log } from './utils.js';
import { PHASES, DEFAULTS } from './events.js';

// ============================================================
// Хранилища
// ============================================================

/** code → Room */
const rooms = new Map();

/** socketId → code (обратный индекс, чтобы быстро найти комнату по сокету) */
const socketToRoom = new Map();

// ============================================================
// Создание / вход / выход
// ============================================================

/**
 * Создаёт новую комнату. Создатель становится хостом.
 * @returns {Room}
 */
export function createRoom(socketId, rawName) {
  const name = sanitizeName(rawName) || 'Хост';
  const code = generateCode(c => rooms.has(c));

  const room = {
    code,
    hostId: socketId,
    phase: PHASES.LOBBY,
    roundNumber: 0,
    gameId: null,          // ID партии в БД, ставится при старте
    round: null,           // состояние текущего раунда
    players: [{
      id: socketId,
      name,
      score: 0,
      connected: true,
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

/**
 * Подключает игрока к существующей комнате.
 * @returns {{ ok: true, room: Room } | { ok: false, error: string }}
 */
export function joinRoom(rawCode, socketId, rawName) {
  const code = String(rawCode || '').toUpperCase().trim();
  const room = rooms.get(code);

  if (!room) {
    return { ok: false, error: 'Комната не найдена' };
  }
  if (room.phase !== PHASES.LOBBY) {
    return { ok: false, error: 'Игра уже началась' };
  }
  if (room.players.length >= DEFAULTS.MAX_PLAYERS) {
    return { ok: false, error: `Комната полна (${DEFAULTS.MAX_PLAYERS})` };
  }

  const name = sanitizeName(rawName) || `Игрок ${room.players.length + 1}`;
  const finalName = uniqueName(room, name);

  room.players.push({
    id: socketId,
    name: finalName,
    score: 0,
    connected: true,
    joinedAt: Date.now(),
  });
  socketToRoom.set(socketId, code);
  touch(room);

  log('room', `«${finalName}» вошёл в ${code} (${room.players.length} игроков)`);
  return { ok: true, room };
}

/**
 * Отключает игрока от комнаты.
 * Если комната опустела — удаляет её.
 * Если ушёл хост — передаёт хоста следующему.
 * @returns {Room | null} Обновлённая комната или null, если удалена.
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

  // Комната опустела — сносим
  if (room.players.length === 0) {
    rooms.delete(code);
    log('room', `${code} удалена (пусто)`);
    return null;
  }

  // Ушёл хост — передаём следующему
  if (room.hostId === socketId) {
    room.hostId = room.players[0].id;
    log('room', `${code}: хост передан «${room.players[0].name}»`);
  }

  touch(room);
  log('room', `«${name}» вышел из ${code} (${room.players.length} осталось)`);
  return room;
}

// ============================================================
// Поиск
// ============================================================

/** Комната по сокету. */
export function getRoomBySocket(socketId) {
  const code = socketToRoom.get(socketId);
  return code ? rooms.get(code) ?? null : null;
}

/** Комната по коду. */
export function getRoomByCode(code) {
  return rooms.get(String(code || '').toUpperCase()) ?? null;
}

/** Игрок по сокету (внутри комнаты). */
export function getPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId) ?? null;
}

/** Является ли игрок хостом. */
export function isHost(room, socketId) {
  return room.hostId === socketId;
}

/** Является ли игрок судьёй в текущем раунде. */
export function isJudge(room, socketId) {
  return room.round?.judgeId === socketId;
}

// ============================================================
// Мутации
// ============================================================

/** Обновляет отметку активности комнаты. */
export function touch(room) {
  room.lastActivityAt = Date.now();
}

/** Начисляет очки игроку. */
export function addScore(room, socketId, points) {
  const p = getPlayer(room, socketId);
  if (p) p.score += points;
  touch(room);
}

/** Меняет фазу и обновляет активность. */
export function setPhase(room, phase) {
  room.phase = phase;
  touch(room);
}

// ============================================================
// Очистка мёртвых комнат
// ============================================================

/**
 * Удаляет комнаты, где никого нет ИЛИ давно не было активности.
 * Запускается по таймеру из index.js.
 */
export function cleanupStaleRooms() {
  const now = Date.now();
  const ttl = DEFAULTS.ROOM_TTL;
  let removed = 0;

  for (const [code, room] of rooms) {
    const noPlayers = room.players.length === 0;
    const stale = now - room.lastActivityAt > ttl;
    if (noPlayers || stale) {
      // Чистим обратный индекс
      for (const p of room.players) {
        socketToRoom.delete(p.id);
      }
      rooms.delete(code);
      removed++;
      log('room', `${code} удалена (${noPlayers ? 'пусто' : 'простой'})`);
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
  for (const room of rooms.values()) {
    totalPlayers += room.players.length;
  }
  return {
    rooms: rooms.size,
    players: totalPlayers,
    codes: [...rooms.keys()],
  };
}

// ============================================================
// Внутренние хелперы
// ============================================================

/**
 * Если имя уже занято в комнате — добавляет « 2», « 3» и т.д.
 * Чтобы в лобби не было двух «Аня».
 */
function uniqueName(room, base) {
  const taken = new Set(room.players.map(p => p.name));
  if (!taken.has(base)) return base;

  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now() % 1000}`;
}