// ============================================================
// Игровая логика режима «Классика» с таймерами.
// ============================================================

import { PHASES, EVENTS, DEFAULTS, DURATIONS } from './events.js';
import { memesRepo, promptsRepo, gamesRepo, roundsRepo } from './db.js';
import { pickRandom, log } from './utils.js';
import { addScore, setPhase, touch } from './rooms.js';

let MEMES_CACHE = [];
let PROMPTS_CACHE = [];

export function reloadPools() {
  MEMES_CACHE = memesRepo.all();
  PROMPTS_CACHE = promptsRepo.all();
  log('game', `Пулы: мемов ${MEMES_CACHE.length}, заданий ${PROMPTS_CACHE.length}`);
}

export function getMemesCount()   { return MEMES_CACHE.length; }
export function getPromptsCount() { return PROMPTS_CACHE.length; }

// ============================================================
// Публичное состояние
// ============================================================

export function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    roundNumber: room.roundNumber,
    hostId: room.hostId,
    hostToken: room.hostToken,
    judgeId: room.round?.judgeId ?? null,
    prompt: room.round?.prompt ?? null,
    timerEnd: room.round?.timerEnd ?? null,
    players: room.players.map(p => ({
      id: p.id,
      token: p.token,
      name: p.name,
      score: p.score,
      connected: p.connected !== false,
    })),
  };
}

/**
 * Полное состояние игрока для rejoin — что показать после перезагрузки.
 */
export function playerView(room, socketId) {
  const isJudge = room.round?.judgeId === socketId;
  const hand = room.round?.hands?.[socketId] ?? null;
  const submitted = !!room.round?.submissions?.[socketId];
  const submittedCombo = room.round?.submissions?.[socketId]?.map(id =>
    MEMES_CACHE.find(m => m.id === id)
  ).filter(Boolean) ?? null;

  const isJudgePhase = room.phase === PHASES.JUDGE_PICKS_WINNER && isJudge;
  const combos = isJudgePhase
    ? Object.entries(room.round.submissions).map(([pid, ids]) => ({
        pid,
        memes: ids.map(id => MEMES_CACHE.find(m => m.id === id)).filter(Boolean),
      }))
    : null;

  const promptOptions = (room.phase === PHASES.JUDGE_PICKS_PROMPT && isJudge)
    ? room.round.promptOptions
    : null;

  return { hand, submitted, submittedCombo, combos, promptOptions };
}

// ============================================================
// Таймеры
// ============================================================

function clearTimer(room) {
  if (room.round?.timerInterval) {
    clearInterval(room.round.timerInterval);
    room.round.timerInterval = null;
  }
  if (room._revealTimer) {
    clearTimeout(room._revealTimer);
    room._revealTimer = null;
  }
  if (room.round) room.round.timerEnd = null;
}

function startTimer(room, io, durationMs, onExpire) {
  clearTimer(room);
  const end = Date.now() + durationMs;
  room.round.timerEnd = end;

  // Каждые 1 сек шлём оставшееся время
  room.round.timerInterval = setInterval(() => {
    const remaining = Math.max(0, end - Date.now());
    io.to(room.code).emit(EVENTS.TIMER_TICK, { remaining });

    if (remaining <= 0) {
      clearInterval(room.round.timerInterval);
      room.round.timerInterval = null;
      room.round.timerEnd = null;
      try { onExpire(); } catch (e) { log('game', 'timer expire error:', e.message); }
    }
  }, 1000);

  // Первый tick сразу
  io.to(room.code).emit(EVENTS.TIMER_TICK, { remaining: durationMs });
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
    throw new Error(`Мало мемов: нужно минимум ${DEFAULTS.HAND_SIZE}, есть ${MEMES_CACHE.length}`);
  }
  if (PROMPTS_CACHE.length < DEFAULTS.PROMPT_CHOICES) {
    throw new Error(`Мало заданий: нужно минимум ${DEFAULTS.PROMPT_CHOICES}, есть ${PROMPTS_CACHE.length}`);
  }

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
  clearTimer(room);
  room.roundNumber += 1;

  const active = room.players.filter(p => p.connected !== false);
  const judgeIdx = (room.roundNumber - 1) % active.length;
  const judge = active[judgeIdx];

  const hands = {};
  for (const p of active) {
    if (p.id === judge.id) continue;
    hands[p.id] = pickRandom(MEMES_CACHE, DEFAULTS.HAND_SIZE);
  }

  const promptOptions = pickRandom(PROMPTS_CACHE, DEFAULTS.PROMPT_CHOICES);

  room.round = {
    judgeId: judge.id,
    promptOptions,
    prompt: null,
    hands,
    submissions: {},
    winnerId: null,
    timerEnd: null,
    timerInterval: null,
  };

  setPhase(room, PHASES.JUDGE_PICKS_PROMPT);

  io.to(room.code).emit(EVENTS.PHASE_CHANGE, {
    phase: room.phase,
    roundNumber: room.roundNumber,
  });
  io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));

  io.to(judge.id).emit(EVENTS.SUBMISSIONS, {
    type: 'prompt_options',
    options: promptOptions,
  });

  for (const [pid, hand] of Object.entries(hands)) {
    io.to(pid).emit(EVENTS.YOUR_HAND, { hand });
  }

  log('game', `${room.code} R${room.roundNumber}: судья «${judge.name}»`);

  // Таймер на выбор задания
  startTimer(room, io, DURATIONS.JUDGE_PICKS_PROMPT, () => {
    // Судья не успел — выбираем случайное
    if (room.phase !== PHASES.JUDGE_PICKS_PROMPT) return;
    const randomPrompt = pickRandom(promptOptions, 1)[0];
    log('game', `${room.code} R${room.roundNumber}: судья не успел, авто-выбор задания`);
    applyPrompt(room, randomPrompt, io);
  });
}

// ============================================================
// Фаза 2: судья выбрал задание
// ============================================================

export function pickPrompt(room, socketId, promptId, io) {
  if (room.phase !== PHASES.JUDGE_PICKS_PROMPT) return;
  if (room.round.judgeId !== socketId) return;

  const prompt = room.round.promptOptions.find(p => p.id === promptId);
  if (!prompt) return;

  applyPrompt(room, prompt, io);
}

function applyPrompt(room, prompt, io) {
  clearTimer(room);
  room.round.prompt = prompt;
  setPhase(room, PHASES.PLAYERS_SUBMIT);

  io.to(room.code).emit(EVENTS.PHASE_CHANGE, {
    phase: room.phase,
    prompt,                             // всегда передаём — не затираем
  });
  io.to(room.code).emit(EVENTS.ROOM_STATE, publicRoom(room));

  log('game', `${room.code} R${room.roundNumber}: задание «${prompt.text}»`);

  startTimer(room, io, DURATIONS.PLAYERS_SUBMIT, () => {
    if (room.phase !== PHASES.PLAYERS_SUBMIT) return;
    log('game', `${room.code} R${room.roundNumber}: время вышло, переходим к судье`);
    moveToJudgePicks(room, io);
  });
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
  if (!memeIds.every(id => hand.some(m => m.id === id))) {
    return { ok: false, error: 'Этого мема нет в руке' };
  }

  room.round.submissions[socketId] = memeIds;
  touch(room);

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
    clearTimer(room);
    moveToJudgePicks(room, io);
  }
  return { ok: true };
}

function moveToJudgePicks(room, io) {
  // Если никто не отправил — рандомное комбо от случайного игрока,
  // чтобы не застрять
  if (Object.keys(room.round.submissions).length === 0) {
    const active = room.players.filter(
      p => p.connected !== false && p.id !== room.round.judgeId
    );
    if (active.length > 0) {
      const victim = active[Math.floor(Math.random() * active.length)];
      const hand = room.round.hands[victim.id] ?? [];
      if (hand.length >= 2) {
        room.round.submissions[victim.id] = [hand[0].id, hand[1].id];
        log('game', `${room.code} R${room.roundNumber}: никто не отправил, авто-комбо от «${victim.name}»`);
      }
    }
  }

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

  startTimer(room, io, DURATIONS.JUDGE_PICKS_WINNER, () => {
    if (room.phase !== PHASES.JUDGE_PICKS_WINNER) return;
    // Судья не выбрал — рандомный победитель
    const pids = Object.keys(room.round.submissions);
    if (pids.length > 0) {
      const randomWinner = pids[Math.floor(Math.random() * pids.length)];
      log('game', `${room.code} R${room.roundNumber}: судья не выбрал, авто-победитель`);
      applyWinner(room, room.round.judgeId, randomWinner, io);
    }
  });
}

// ============================================================
// Фаза 4: судья выбрал победителя
// ============================================================

export function pickWinner(room, socketId, winnerPid, io) {
  if (room.phase !== PHASES.JUDGE_PICKS_WINNER) return;
  if (room.round.judgeId !== socketId) return;
  if (!room.round.submissions[winnerPid]) return;

  applyWinner(room, socketId, winnerPid, io);
}

function applyWinner(room, judgeId, winnerPid, io) {
  clearTimer(room);
  room.round.winnerId = winnerPid;

  addScore(room, winnerPid, 1000);
  addScore(room, judgeId, 500);

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

  io.to(room.code).emit(EVENTS.PHASE_CHANGE, { phase: room.phase, prompt: room.round.prompt });
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

function scheduleNextPhase(room, io) {
  clearTimer(room);

  room._revealTimer = setTimeout(() => {
    room._revealTimer = null;
    if (!room.players.length) return;

    const active = room.players.filter(p => p.connected !== false);
    if (active.length < DEFAULTS.MIN_PLAYERS) {
      finishGame(room, io);
      return;
    }
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
  clearTimer(room);
  setPhase(room, PHASES.GAME_OVER);

  if (room.gameId) {
    try { gamesRepo.finish(room.gameId); } catch (e) {
      log('game', 'Ошибка финализации партии:', e.message);
    }
  }

  const finalScores = [...room.players]
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  io.to(room.code).emit(EVENTS.GAME_OVER, { players: finalScores });
  log('game', `${room.code}: партия #${room.gameId} окончена, победитель «${finalScores[0]?.name}»`);
}

// ============================================================
// Сохранение раунда
// ============================================================

function saveRoundToDb(room) {
  if (!room.gameId) return;
  try {
    const judge  = room.players.find(p => p.id === room.round.judgeId);
    const winner = room.players.find(p => p.id === room.round.winnerId);

    const roundId = roundsRepo.save({
      gameId: room.gameId,
      number: room.roundNumber,
      judgeName: judge?.name ?? '???',
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
// Обработка явного выхода
// ============================================================

export function handlePlayerLeave(room, socketId, io) {
  if (!room.round || room.phase === PHASES.LOBBY || room.phase === PHASES.GAME_OVER) return;

  clearTimer(room);

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

  delete room.round.submissions[socketId];
  delete room.round.hands[socketId];

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

  if (room.phase === PHASES.REVEAL) {
    scheduleNextPhase(room, io);
  }
}