// ============================================================
// Репозиторий пользователей: профиль, статистика, рейтинг.
// ============================================================

import { db } from './db.js';
import { DEFAULTS, LEADERBOARD_LIMIT } from './events.js';

// ============================================================
// Чтение
// ============================================================

export function findById(id) {
  const row = db.prepare(`
    SELECT id, username, created_at, last_seen_at,
           games_played, games_won, total_score
    FROM users WHERE id = ?
  `).get(id);
  return row ? decorate(row) : null;
}

export function findByUsername(username) {
  if (typeof username !== 'string') return null;
  const row = db.prepare(`
    SELECT id, username, created_at, last_seen_at,
           games_played, games_won, total_score
    FROM users WHERE username = ?
  `).get(username.trim());
  return row ? decorate(row) : null;
}

/**
 * Дополняет запись вычисляемыми полями: winrate, avg_score.
 */
function decorate(row) {
  const played = row.games_played ?? 0;
  const won    = row.games_won ?? 0;
  return {
    id: row.id,
    username: row.username,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    games_played: played,
    games_won: won,
    total_score: row.total_score ?? 0,
    winrate: played > 0 ? Math.round((won / played) * 100) : 0,
    avg_score: played > 0 ? Math.round((row.total_score ?? 0) / played) : 0,
  };
}

// ============================================================
// Статистика
// ============================================================

/**
 * Обновляет статистику юзера после партии.
 * @param {number} userId
 * @param {number} score   — итоговый счёт игрока в партии
 * @param {boolean} isWinner — занял ли 1-е место
 */
export function updateStats(userId, score, isWinner) {
  if (!userId) return;
  db.prepare(`
    UPDATE users SET
      games_played = games_played + 1,
      games_won    = games_won + ?,
      total_score  = total_score + ?,
      last_seen_at = unixepoch()
    WHERE id = ?
  `).run(isWinner ? 1 : 0, score, userId);
}

// ============================================================
// Рейтинги (топ-20 по трём категориям)
// ============================================================

export function leaderboard(type = 'score', limit = LEADERBOARD_LIMIT) {
  switch (type) {
    case 'score':
      return db.prepare(`
        SELECT id, username, total_score AS value, games_played, games_won
        FROM users
        WHERE games_played > 0
        ORDER BY total_score DESC, games_won DESC, username ASC
        LIMIT ?
      `).all(limit).map((r, i) => ({ rank: i + 1, ...r, unit: 'очков' }));

    case 'wins':
      return db.prepare(`
        SELECT id, username, games_won AS value, games_played, total_score
        FROM users
        WHERE games_played > 0
        ORDER BY games_won DESC, total_score DESC, username ASC
        LIMIT ?
      `).all(limit).map((r, i) => ({ rank: i + 1, ...r, unit: 'побед' }));

    case 'winrate':
      // Только те, кто сыграл 5+ партий — иначе у одного победителя из одной игры будет 100%
      return db.prepare(`
        SELECT id, username,
               CAST(ROUND(100.0 * games_won / games_played) AS INTEGER) AS value,
               games_played, games_won, total_score
        FROM users
        WHERE games_played >= 5
        ORDER BY value DESC, games_won DESC, games_played DESC
        LIMIT ?
      `).all(limit).map((r, i) => ({ rank: i + 1, ...r, unit: '%' }));

    default:
      return [];
  }
}

// ============================================================
// История партий игрока
// ============================================================

/**
 * Последние N партий игрока с рассчитанным местом.
 */
export function recentGames(userId, limit = 20) {
  if (!userId) return [];

  const rows = db.prepare(`
    SELECT
      g.id           AS game_id,
      g.room_code,
      g.mode,
      g.started_at,
      g.ended_at,
      gp.score       AS my_score,
      gp.player_name AS my_name,
      (SELECT COUNT(*) FROM game_players WHERE game_id = g.id) AS total_players,
      (SELECT COUNT(*) FROM game_players
       WHERE game_id = g.id AND score > gp.score) AS better_count
    FROM game_players gp
    JOIN games g ON g.id = gp.game_id
    WHERE gp.user_id = ?
    ORDER BY g.started_at DESC
    LIMIT ?
  `).all(userId, limit);

  return rows.map(r => ({
    game_id: r.game_id,
    room_code: r.room_code,
    mode: r.mode,
    started_at: r.started_at,
    ended_at: r.ended_at,
    score: r.my_score,
    place: r.better_count + 1,
    total_players: r.total_players,
    won: r.better_count === 0,
  }));
}

// ============================================================
// Общая статистика сайта
// ============================================================

export function totalUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}