// ============================================================
// Аутентификация: регистрация, логин, сессии, хеширование.
// Только встроенные модули Node — работает на Termux без нативных сборок.
// ============================================================

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
import { DEFAULTS } from './events.js';
import { log } from './utils.js';

const scrypt = promisify(scryptCb);

const SCRYPT_KEYLEN = 64;
const SALT_LEN = 16;

// ============================================================
// Хеширование пароля
// ============================================================

/**
 * Хеширует пароль. Возвращает строку "salt:hash" в hex.
 */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Проверяет пароль против сохранённого хеша. Защищено от timing-атак.
 */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== SCRYPT_KEYLEN) return false;

  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  try {
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ============================================================
// Валидация
// ============================================================

export function validateUsername(name) {
  if (typeof name !== 'string') return { ok: false, error: 'Имя обязательно' };
  const trimmed = name.trim();
  if (trimmed.length < DEFAULTS.USERNAME_MIN) {
    return { ok: false, error: `Имя минимум ${DEFAULTS.USERNAME_MIN} символа` };
  }
  if (trimmed.length > DEFAULTS.USERNAME_MAX) {
    return { ok: false, error: `Имя максимум ${DEFAULTS.USERNAME_MAX} символов` };
  }
  if (!/^[a-zA-Zа-яА-Я0-9_-]+$/.test(trimmed)) {
    return { ok: false, error: 'Только буквы, цифры, _ и -' };
  }
  return { ok: true, value: trimmed };
}

export function validatePassword(password) {
  if (typeof password !== 'string') return { ok: false, error: 'Пароль обязателен' };
  if (password.length < DEFAULTS.PASSWORD_MIN) {
    return { ok: false, error: `Пароль минимум ${DEFAULTS.PASSWORD_MIN} символов` };
  }
  if (password.length > DEFAULTS.PASSWORD_MAX) {
    return { ok: false, error: `Пароль максимум ${DEFAULTS.PASSWORD_MAX} символов` };
  }
  return { ok: true, value: password };
}

// ============================================================
// Сессии
// ============================================================

function generateSessionToken() {
  return randomBytes(32).toString('hex');
}

/**
 * Создаёт новую сессию для пользователя. Возвращает токен.
 */
export function createSession(userId) {
  const token = generateSessionToken();
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULTS.SESSION_TTL;

  db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(token, userId, expiresAt);

  return token;
}

/**
 * Проверяет токен. Возвращает user или null.
 * Обновляет last_used_at, удаляет просроченные.
 */
export function verifySession(token) {
  if (!token || typeof token !== 'string') return null;

  const row = db.prepare(`
    SELECT s.token, s.user_id, s.expires_at, u.username,
           u.games_played, u.games_won, u.total_score, u.created_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);

  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  db.prepare('UPDATE sessions SET last_used_at = unixepoch() WHERE token = ?').run(token);
  db.prepare('UPDATE users SET last_seen_at = unixepoch() WHERE id = ?').run(row.user_id);

  return {
    id: row.user_id,
    username: row.username,
    games_played: row.games_played,
    games_won: row.games_won,
    total_score: row.total_score,
    created_at: row.created_at,
  };
}

/**
 * Удаляет сессию.
 */
export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * Удаляет все просроченные сессии. Вызывать периодически.
 */
export function cleanupExpiredSessions() {
  const now = Math.floor(Date.now() / 1000);
  const r = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  if (r.changes > 0) log('auth', `Очищено сессий: ${r.changes}`);
}

// ============================================================
// Регистрация / логин
// ============================================================

/**
 * Регистрирует нового пользователя.
 * @returns {{ ok: true, token, user } | { ok: false, error }}
 */
export async function register(rawUsername, rawPassword) {
  const u = validateUsername(rawUsername);
  if (!u.ok) return { ok: false, error: u.error };
  const p = validatePassword(rawPassword);
  if (!p.ok) return { ok: false, error: p.error };

  // Проверка уникальности (COLLATE NOCASE)
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u.value);
  if (existing) return { ok: false, error: 'Такое имя уже занято' };

  const hash = await hashPassword(p.value);

  let userId;
  try {
    const r = db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ).run(u.value, hash);
    userId = Number(r.lastInsertRowid);
  } catch (e) {
    log('auth', 'register insert error:', e.message);
    return { ok: false, error: 'Не удалось создать аккаунт' };
  }

  const token = createSession(userId);
  const user = {
    id: userId,
    username: u.value,
    games_played: 0,
    games_won: 0,
    total_score: 0,
  };

  log('auth', `Регистрация: «${u.value}» (#${userId})`);
  return { ok: true, token, user };
}

/**
 * Логин по имени и паролю.
 */
export async function login(rawUsername, rawPassword) {
  if (typeof rawUsername !== 'string' || typeof rawPassword !== 'string') {
    return { ok: false, error: 'Имя и пароль обязательны' };
  }

  const row = db.prepare(`
    SELECT id, username, password_hash, games_played, games_won, total_score
    FROM users WHERE username = ?
  `).get(rawUsername.trim());

  // Всегда делаем проверку — даже если юзера нет, чтобы не было timing leak
  const dummyHash = '00'.repeat(SALT_LEN) + ':' + '00'.repeat(SCRYPT_KEYLEN);
  const valid = await verifyPassword(rawPassword, row?.password_hash ?? dummyHash);

  if (!row || !valid) {
    return { ok: false, error: 'Неверное имя или пароль' };
  }

  const token = createSession(row.id);
  const user = {
    id: row.id,
    username: row.username,
    games_played: row.games_played,
    games_won: row.games_won,
    total_score: row.total_score,
  };

  log('auth', `Вход: «${row.username}» (#${row.id})`);
  return { ok: true, token, user };
}