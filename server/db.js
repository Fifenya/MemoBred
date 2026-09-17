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

fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// Открытие и настройка
// ============================================================

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');

log('db', `Открыта база: ${DB_PATH}`);

// ============================================================
// Базовая схема (создаётся, если ещё нет)
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
// Миграции для аккаунтов
// ============================================================

db.exec(`
  -- ---------- Пользователи ----------

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    games_played  INTEGER NOT NULL DEFAULT 0,
    games_won     INTEGER NOT NULL DEFAULT 0,
    total_score   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_users_score ON users(total_score DESC);
  CREATE INDEX IF NOT EXISTS idx_users_wins  ON users(games_won DESC);

  -- ---------- Сессии ----------

  CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);
`);

// ALTER TABLE: добавляем user_id в game_players (если ещё нет)
function tryAlterGamePlayers() {
  try {
    db.exec(`ALTER TABLE game_players ADD COLUMN user_id INTEGER REFERENCES users(id)`);
    log('db', 'Миграция: game_players.user_id добавлена');
  } catch (e) {
    // колонка уже есть — это нормально
    if (!String(e.message).includes('duplicate column')) {
      log('db', 'Ошибка миграции game_players:', e.message);
    }
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gp_user ON game_players(user_id)`);
  } catch {}
}
tryAlterGamePlayers();

// ============================================================
// Репозиторий: мемы
// ============================================================

export const memesRepo = {
  all({ pack } = {}) {
    return pack
      ? db.prepare('SELECT * FROM memes WHERE pack = ? ORDER BY added_at').all(pack)
      : db.prepare('SELECT * FROM memes ORDER BY added_at').all();
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
      for (const m of list) stmt.run(m.id, m.title, m.url, m.category, m.pack ?? 'starter');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  delete(id) { db.prepare('DELETE FROM memes WHERE id = ?').run(id); },
  count() { return db.prepare('SELECT COUNT(*) AS n FROM memes').get().n; },
};

// ============================================================
// Репозиторий: задания
// ============================================================

export const promptsRepo = {
  all()      { return db.prepare('SELECT * FROM prompts ORDER BY added_at').all(); },
  findById(id) { return db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) || null; },
  insert({ id, text, category = 'general' }) {
    db.prepare(`
      INSERT INTO prompts (id, text, category)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET text = excluded.text, category = excluded.category
    `).run(id, text, category);
  },
  insertMany(list) {
    const stmt = db.prepare(`
      INSERT INTO prompts (id, text, category)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET text = excluded.text, category = excluded.category
    `);
    db.exec('BEGIN');
    try {
      for (const p of list) stmt.run(p.id, p.text, p.category ?? 'general');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  count() { return db.prepare('SELECT COUNT(*) AS n FROM prompts').get().n; },
};

// ============================================================
// Репозиторий: партии
// ============================================================

export const gamesRepo = {
  start(roomCode, mode = 'classic') {
    const r = db.prepare('INSERT INTO games (room_code, mode) VALUES (?, ?)').run(roomCode, mode);
    return Number(r.lastInsertRowid);
  },
  finish(gameId) {
    db.prepare('UPDATE games SET ended_at = unixepoch() WHERE id = ? AND ended_at IS NULL').run(gameId);
  },
  savePlayer(gameId, name, score, userId = null) {
    db.prepare(`
      INSERT INTO game_players (game_id, player_name, score, user_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(game_id, player_name) DO UPDATE SET
        score   = excluded.score,
        user_id = COALESCE(excluded.user_id, game_players.user_id)
    `).run(gameId, name, score, userId);
  },
  topScores(limit = 20) {
    return db.prepare(`
      SELECT player_name, SUM(score) AS total, COUNT(*) AS games
      FROM game_players GROUP BY player_name ORDER BY total DESC LIMIT ?
    `).all(limit);
  },
  recent(limit = 20) {
    return db.prepare(`
      SELECT g.id, g.room_code, g.mode, g.started_at, g.ended_at,
             (SELECT COUNT(*) FROM game_players WHERE game_id = g.id) AS players
      FROM games g ORDER BY g.started_at DESC LIMIT ?
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
    return db.prepare('SELECT * FROM rounds WHERE game_id = ? ORDER BY number').all(gameId);
  },
};

// ============================================================
// Обслуживание
// ============================================================

export function backupTo(targetPath) {
  db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
}
export function vacuum() { db.exec('VACUUM'); }
export function closeDb() {
  try { db.close(); log('db', 'База закрыта'); }
  catch (e) { log('db', 'Ошибка при закрытии:', e.message); }
}