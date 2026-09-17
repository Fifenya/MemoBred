// ============================================================
// SQLite через встроенный node:sqlite (Node ≥ 22.5)
// Единственное место в проекте, где мы трогаем базу.
// ============================================================

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'memobred.db');

// Гарантируем, что папка существует
fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// Открытие и настройка
// ============================================================

export const db = new DatabaseSync(DB_PATH);

// WAL: пишет только изменённые страницы, не весь файл
db.exec('PRAGMA journal_mode = WAL');
// Внешние ключи (по умолчанию в SQLite ВЫКЛЮЧЕНЫ — важно включить)
db.exec('PRAGMA foreign_keys = ON');
// Меньше fsync — быстрее, безопасность приемлемая для игры
db.exec('PRAGMA synchronous = NORMAL');
// Ждать блокировку до 5 сек, если два процесса пишут одновременно
db.exec('PRAGMA busy_timeout = 5000');

log('db', `Открыта база: ${DB_PATH}`);

// ============================================================
// Схема
// ============================================================

db.exec(`
  -- ---------- Контент ----------

  CREATE TABLE IF NOT EXISTS memes (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    url       TEXT NOT NULL,
    category  TEXT NOT NULL,
    pack      TEXT NOT NULL DEFAULT 'starter',
    added_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_memes_pack ON memes(pack);

  CREATE TABLE IF NOT EXISTS prompts (
    id        TEXT PRIMARY KEY,
    text      TEXT NOT NULL,
    category  TEXT NOT NULL DEFAULT 'general',
    added_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category);

  -- ---------- История партий ----------

  CREATE TABLE IF NOT EXISTS games (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code   TEXT NOT NULL,
    mode        TEXT NOT NULL DEFAULT 'classic',
    started_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    ended_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_games_started ON games(started_at DESC);

  CREATE TABLE IF NOT EXISTS game_players (
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_name TEXT NOT NULL,
    score       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, player_name)
  );
  CREATE INDEX IF NOT EXISTS idx_gp_player ON game_players(player_name);

  CREATE TABLE IF NOT EXISTS rounds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,
    judge_name  TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    winner_name TEXT,
    played_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_rounds_game ON rounds(game_id);

  CREATE TABLE IF NOT EXISTS submissions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id     INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    player_name  TEXT NOT NULL,
    meme_ids     TEXT NOT NULL,
    is_winner    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_subs_round ON submissions(round_id);
`);

// ============================================================
// Репозиторий: мемы
// ============================================================

export const memesRepo = {
  all({ pack } = {}) {
    if (pack) {
      return db.prepare(
        'SELECT * FROM memes WHERE pack = ? ORDER BY added_at'
      ).all(pack);
    }
    return db.prepare('SELECT * FROM memes ORDER BY added_at').all();
  },

  findById(id) {
    return db.prepare('SELECT * FROM memes WHERE id = ?').get(id) || null;
  },

  insert({ id, title, url, category, pack = 'starter' }) {
    db.prepare(`
      INSERT INTO memes (id, title, url, category, pack)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title    = excluded.title,
        url      = excluded.url,
        category = excluded.category,
        pack     = excluded.pack
    `).run(id, title, url, category, pack);
  },

  insertMany(list) {
    const stmt = db.prepare(`
      INSERT INTO memes (id, title, url, category, pack)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title    = excluded.title,
        url      = excluded.url,
        category = excluded.category,
        pack     = excluded.pack
    `);
    db.exec('BEGIN');
    try {
      for (const m of list) {
        stmt.run(m.id, m.title, m.url, m.category, m.pack ?? 'starter');
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },

  delete(id) {
    db.prepare('DELETE FROM memes WHERE id = ?').run(id);
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM memes').get().n;
  },
};

// ============================================================
// Репозиторий: задания
// ============================================================

export const promptsRepo = {
  all() {
    return db.prepare('SELECT * FROM prompts ORDER BY added_at').all();
  },

  findById(id) {
    return db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) || null;
  },

  insert({ id, text, category = 'general' }) {
    db.prepare(`
      INSERT INTO prompts (id, text, category)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text     = excluded.text,
        category = excluded.category
    `).run(id, text, category);
  },

  insertMany(list) {
    const stmt = db.prepare(`
      INSERT INTO prompts (id, text, category)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text     = excluded.text,
        category = excluded.category
    `);
    db.exec('BEGIN');
    try {
      for (const p of list) {
        stmt.run(p.id, p.text, p.category ?? 'general');
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM prompts').get().n;
  },
};

// ============================================================
// Репозиторий: партии
// ============================================================

export const gamesRepo = {
  start(roomCode, mode = 'classic') {
    const r = db.prepare(
      'INSERT INTO games (room_code, mode) VALUES (?, ?)'
    ).run(roomCode, mode);
    return Number(r.lastInsertRowid);
  },

  finish(gameId) {
    db.prepare(
      'UPDATE games SET ended_at = unixepoch() WHERE id = ? AND ended_at IS NULL'
    ).run(gameId);
  },

  savePlayer(gameId, name, score) {
    db.prepare(`
      INSERT INTO game_players (game_id, player_name, score)
      VALUES (?, ?, ?)
      ON CONFLICT(game_id, player_name) DO UPDATE SET
        score = excluded.score
    `).run(gameId, name, score);
  },

  topScores(limit = 20) {
    return db.prepare(`
      SELECT player_name,
             SUM(score) AS total,
             COUNT(*)   AS games
      FROM game_players
      GROUP BY player_name
      ORDER BY total DESC
      LIMIT ?
    `).all(limit);
  },

  recent(limit = 20) {
    return db.prepare(`
      SELECT g.id, g.room_code, g.mode,
             g.started_at, g.ended_at,
             (SELECT COUNT(*) FROM game_players WHERE game_id = g.id) AS players
      FROM games g
      ORDER BY g.started_at DESC
      LIMIT ?
    `).all(limit);
  },
};

// ============================================================
// Репозиторий: раунды и комбо
// ============================================================

export const roundsRepo = {
  save({ gameId, number, judgeName, promptText, winnerName = null }) {
    const r = db.prepare(`
      INSERT INTO rounds (game_id, number, judge_name, prompt_text, winner_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(gameId, number, judgeName, promptText, winnerName);
    return Number(r.lastInsertRowid);
  },

  saveSubmission({ roundId, playerName, memeIds, isWinner }) {
    db.prepare(`
      INSERT INTO submissions (round_id, player_name, meme_ids, is_winner)
      VALUES (?, ?, ?, ?)
    `).run(roundId, playerName, JSON.stringify(memeIds), isWinner ? 1 : 0);
  },

  byGame(gameId) {
    return db.prepare(
      'SELECT * FROM rounds WHERE game_id = ? ORDER BY number'
    ).all(gameId);
  },
};

// ============================================================
// Обслуживание
// ============================================================

/**
 * Создаёт консистентный снимок базы (без -wal и -shm).
 * Идеально для бэкапа.
 */
export function backupTo(targetPath) {
  db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
}

/**
 * Компактизация базы: убирает фрагментацию.
 * Останавливает сервер на доли секунды — вызывать вручную.
 */
export function vacuum() {
  db.exec('VACUUM');
}

/**
 * Закрывает БД. Полезно при graceful shutdown.
 */
export function closeDb() {
  try {
    db.close();
    log('db', 'База закрыта');
  } catch (e) {
    log('db', 'Ошибка при закрытии:', e.message);
  }
}