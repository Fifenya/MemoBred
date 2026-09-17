// ============================================================
// Игровая логика режима «Классика».
//
// Раунд:
//   1. Назначается судья (по кругу).
//   2. Судье — 3 варианта задания, остальным — руки по 7 мемов.
//   3. Судья выбирает задание.
//   4. Игроки отправляют по 2 мема.
//   5. Судья вслепую выбирает лучшее комбо.
//   6. Раскрытие + очки + следующий раунд.
//
// Партия длится N раундов, где N = число игроков (каждый по разу судья).
// ============================================================

import { PHASES, EVENTS, DEFAULTS } from './events.js';
import {
  memesRepo, promptsRepo, gamesRepo, roundsRepo,
} from './db.js';
import { pickRandom, log } from './utils.js';
import { addScore, setPhase, touch } from './rooms.js';

// ============================================================
// Кэш пулов (обновляется через reloadPools)
// ============================================================

let MEMES_CACHE = [];
let PROMPTS_CACHE = [];

/**
 * Перечитывает мемы и задания из БД в память.
 * Вызывать при старте сервера и после добавления нового контента.
 */
export function reloadPools() {
  MEMES_CACHE = memesRepo.all();
  PROMPTS_CACHE = promptsRepo.all();
  log('game', `Пулы: мемов ${MEMES_CACHE.length}, заданий ${PROMPTS_CACHE.length}`);
}

export function getMemesCount()   { return MEMES_CACHE.length; }
export function getPromptsCount() { return PROMPTS_CACHE.length; }

// ============================================================
// Публичное представление комнаты (для ROOM_STATE)
// ============================================================

export function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    roundNumber: room.roundNumber,
    hostId: room.hostId,
    judgeId: room.round?.judgeId ?? null,
    prompt: room.round?.prompt ?? null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected !== false,   // soft disconnect: показываем статус
    })),
  };
}

// ============================================================
// Старт партии
// ============================================================

export function startGame(room, io) {
  const connected = room.players.filter(p => p.connected !== false);

  if (connected.length < DEFAULTS.MIN_PLAYERS) {
    throw new Error(`Нужно минимум ${DEFAULTS.MIN_PLAYERS} игрока`);
  }
  if (MEMES_CACHE.length < DEFAULTS.HAND_SIZE) {
    throw new Error(
      `Мало мемов: нужно минимум ${DEFAULTS.HAND_SIZE}, есть ${MEMES_CACHE.length}`
    );
  }
  if (PROMPTS_CACHE.length < DEFAULTS.PROMPT_CHOICES) {
    throw new Error(
      `Мало заданий: нужно минимум ${DEFAULTS.PROMPT_CHOICES}, есть ${PROMPTS_CACHE.length}`
    );
  }

  // Создаём запись партии в БД
  room.gameId = gamesRepo.start(room.code, 'classic');
  for (const p of room.players) {
    gamesRepo.savePlayer(room.gameId, p.name, 0);
  }

  room.roundNumber = 0;
  log('game', `${room.code}: партия #${room.gameId} началась (${connected.length} игроков)`);

  startRound(room, io);
}

// ============================================================
// Старт раунда
// ============================================================

export function startRound(room, io) {
  room.roundNumber += 1;

  // Играют только подключённые
  const active = room.players.filter(p => p.connected !== false);

  // Судья — по кругу среди активных
  const judgeIdx = (room.roundNumber - 1) % active.length;
  const judge = active[judgeIdx];

  // Раздача рук: всем активным, кроме судьи
  const hands = {};
  for (const p of active) {
    if (p.id === judge.id) continue;
    hands[p.id] = pickRandom(MEMES_CACHE, DEFAULTS.HAND_SIZE);
  }

  // 3 варианта задания для судьи
  const promptOptions = pickRandom(PROMPTS_CACHE, DEFAULTS.PROMPT_CHOICES);

  room.round = {
    judgeId: judge.id,
    promptOptions,
    prompt: null,
    hands,
    submissions: {},   // playerId → [memeId, memeId]
    winnerId: null,
  };

  setPhase(room, PHASES.JUDGE_PICKS_PROMPT);

  io.to(room.code).emit(EVENTS.PHASE_CHANGE, {
    phase: room.phase,
    roundNumber: room.roundNumber,
  });
  io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));

  // Судье — варианты заданий
  io.to(judge.id).emit(EVENTS.SUBMISSIONS, {
    type: 'prompt_options',
    options: promptOptions,
  });

  // Игрокам — их руки
  for (const [pid, hand] of Object.entries(hands)) {
    io.to(pid).emit(EVENTS.YOUR_HAND, { hand });
  }

  log('game', `${room.code} R${room.roundNumber}: судья «${judge.name}»`);
}

// ============================================================
// Фаза 2: судья выбрал задание
// ============================================================

export function pickPrompt(room, socketId, promptId, io) {
  if (room.phase !== PHASES.JUDGE_PICKS_PROMPT) return;
  if (room.round.judgeId !== socketId) return;

  const prompt = room.round.promptOptions.find(p => p.id === promptId);
  if (!prompt) return;

  room.round.prompt = prompt;
  setPhase(room, PHASES.PLAYERS_SUBMIT);

  io.to(room.code).emit(EVENTS.PHASE_CHANGE, {
    phase: room.phase,
    prompt,
  });
  io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));

  log('game', `${room.code} R${room.roundNumber}: задание «${prompt.text}»`);
}

// ============================================================
// Фаза 3: игрок отправил комбо
// ============================================================

export function submitCombo(room, socketId, memeIds, io) {
  if (room.phase !== PHASES.PLAYERS_SUBMIT) {
    return { ok: false, error: 'Сейчас не фаза отправки' };
  }
  if (room.round.judgeId === socketId) {
    return { ok: false, error: 'Судья не участвует в отправке' };
  }
  if (room.round.submissions[socketId]) {
    return { ok: false, error: 'Ты уже отправил комбо' };
  }

  if (!Array.isArray(memeIds) || memeIds.length !== DEFAULTS.COMBO_SIZE) {
    return { ok: false, error: `Нужно ${DEFAULTS.COMBO_SIZE} мема` };
  }
  if (new Set(memeIds).size !== memeIds.length) {
    return { ok: false, error: 'Мемы не должны повторяться' };
  }

  const hand = room.round.hands[socketId] ?? [];
  const valid = memeIds.every(id => hand.some(m => m.id === id));
  if (!valid) {
    return { ok: false, error: 'Этого мема нет в руке' };
  }

  room.round.submissions[socketId] = memeIds;
  touch(room);

  // Ожидаем от всех активных, кроме судьи
  const expected = room.players.filter(
    p => p.connected !== false && p.id !== room.round.judgeId
  ).length;
  const submitted = Object.keys(room.round.submissions).length;

  io.to(room.code).emit(EVENTS.SCORE_UPDATE, {
    type: 'submission_progress',
    submitted,
    expected,
  });

  log('game', `${room.code} R${room.roundNumber}: комбо ${submitted}/${expected}`);

  if (submitted >= expected) {
    moveToJudgePicks(room, io);
  }
  return { ok: true };
}

function moveToJudgePicks(room, io) {
  setPhase(room, PHASES.JUDGE_PICKS_WINNER);

  const anonymous = Object.entries(room.round.submissions).map(([pid, ids]) => ({
    pid,
    memes: ids.map(id => MEMES_CACHE.find(m => m.id === id)).filter(Boolean),
  }));

  io.to(room.code).emit(EVENTS.PHASE_CHANGE, { phase: room.phase });

  io.to(room.round.judgeId).emit(EVENTS.SUBMISSIONS, {
    type: 'combos',
    combos: anonymous,
  });

  log('game', `${room.code} R${room.roundNumber}: судья выбирает победителя`);
}

// ============================================================
// Фаза 4: судья выбрал победителя
// ============================================================

export function pickWinner(room, socketId, winnerPid, io) {
  if (room.phase !== PHASES.JUDGE_PICKS_WINNER) return;
  if (room.round.judgeId !== socketId) return;
  if (!room.round.submissions[winnerPid]) return;

  room.round.winnerId = winnerPid;

  addScore(room, winnerPid, 1000);
  addScore(room, socketId, 500);

  saveRoundToDb(room);

  setPhase(room, PHASES.REVEAL);

  const revealed = Object.entries(room.round.submissions).map(([pid, ids]) => {
    const player = room.players.find(p => p.id === pid);
    return {
      pid,
      playerName: player?.name ?? '???',
      memes: ids.map(id => MEMES_CACHE.find(m => m.id === id)).filter(Boolean),
      isWinner: pid === winnerPid,
    };
  });

  io.to(room.code).emit(EVENTS.REVEAL, {
    prompt: room.round.prompt,
    combos: revealed,
    winnerId: winnerPid,
  });
  io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));

  const winnerName = room.players.find(p => p.id === winnerPid)?.name ?? '???';
  log('game', `${room.code} R${room.roundNumber}: победил «${winnerName}»`);

  scheduleNextPhase(room, io);
}

// ============================================================
// Переход после раскрытия
// ============================================================

function scheduleNextPhase(room, io) {
  if (room._revealTimer) {
    clearTimeout(room._revealTimer);
    room._revealTimer = null;
  }

  room._revealTimer = setTimeout(() => {
    room._revealTimer = null;

    if (!room.players.length) return;

    const active = room.players.filter(p => p.connected !== false);
    if (active.length < DEFAULTS.MIN_PLAYERS) {
      // Игроков стало мало — завершаем партию
      finishGame(room, io);
      return;
    }

    // Партия длится N раундов — каждый по разу судья (среди активных)
    if (room.roundNumber >= active.length) {
      finishGame(room, io);
    } else {
      startRound(room, io);
    }
  }, DEFAULTS.REVEAL_DELAY);
}

// ============================================================
// Финал
// ============================================================

function finishGame(room, io) {
  setPhase(room, PHASES.GAME_OVER);

  if (room.gameId) {
    try {
      gamesRepo.finish(room.gameId);
    } catch (e) {
      log('game', 'Ошибка финализации партии:', e.message);
    }
  }

  const finalScores = [...room.players]
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  io.to(room.code).emit(EVENTS.GAME_OVER, { players: finalScores });

  log('game',
    `${room.code}: партия #${room.gameId} окончена, победитель «${finalScores[0]?.name}»`);
}

// ============================================================
// Сохранение раунда в БД
// ============================================================

function saveRoundToDb(room) {
  if (!room.gameId) return;

  try {
    const judge  = room.players.find(p => p.id === room.round.judgeId);
    const winner = room.players.find(p => p.id === room.round.winnerId);

    const roundId = roundsRepo.save({
      gameId:     room.gameId,
      number:     room.roundNumber,
      judgeName:  judge?.name ?? '???',
      promptText: room.round.prompt?.text ?? '',
      winnerName: winner?.name ?? null,
    });

    for (const [pid, ids] of Object.entries(room.round.submissions)) {
      const player = room.players.find(p => p.id === pid);
      if (!player) continue;
      roundsRepo.saveSubmission({
        roundId,
        playerName: player.name,
        memeIds: ids,
        isWinner: pid === room.round.winnerId,
      });
    }

    for (const p of room.players) {
      gamesRepo.savePlayer(room.gameId, p.name, p.score);
    }
  } catch (e) {
    log('game', 'Ошибка сохранения раунда:', e.message);
  }
}

// ============================================================
// Обработка выхода игрока во время партии
// ============================================================

/**
 * Вызывается при ЯВНОМ выходе (кнопка) и при окончательном
 * выпадении из игры (после grace-периода soft disconnect).
 * Мягкая обработка: партия не падает из-за одного ушедшего.
 */
export function handlePlayerLeave(room, socketId, io) {
  if (!room.round || room.phase === PHASES.LOBBY || room.phase === PHASES.GAME_OVER) {
    return;
  }

  // Отменяем запланированный таймер — сейчас пересчитаем
  if (room._revealTimer) {
    clearTimeout(room._revealTimer);
    room._revealTimer = null;
  }

  // --- Ушёл судья ---
  if (room.round.judgeId === socketId) {
    log('game', `${room.code}: судья вышел, прерываю раунд`);

    const active = room.players.filter(p => p.connected !== false);

    if (active.length >= DEFAULTS.MIN_PLAYERS) {
      room.roundNumber -= 1;
      startRound(room, io);
    } else {
      finishGame(room, io);
    }
    return;
  }

  // --- Ушёл обычный игрок ---
  delete room.round.submissions[socketId];
  delete room.round.hands[socketId];

  // Если ждали отправок и все оставшиеся отправили — двигаемся дальше
  if (room.phase === PHASES.PLAYERS_SUBMIT) {
    const expected = room.players.filter(
      p => p.connected !== false && p.id !== room.round.judgeId
    ).length;
    const submitted = Object.keys(room.round.submissions).length;

    if (expected > 0 && submitted >= expected) {
      moveToJudgePicks(room, io);
    } else {
      io.to(room.code).emit(EVENTS.SCORE_UPDATE, {
        type: 'submission_progress',
        submitted,
        expected,
      });
    }
    return;
  }

  if (room.phase === PHASES.JUDGE_PICKS_WINNER) {
    // Судья уже выбирает из оставшихся — ничего не делаем
    return;
  }

  if (room.phase === PHASES.REVEAL) {
    scheduleNextPhase(room, io);
  }
}