// ============================================================
// Общий контракт клиент ↔ сервер
// Используется и на сервере, и в public/app.js
// ============================================================

export const EVENTS = {
  // --- клиент → сервер ---
  CREATE_ROOM:   'create_room',
  JOIN_ROOM:     'join_room',
  START_GAME:    'start_game',
  PICK_PROMPT:   'pick_prompt',
  SUBMIT_COMBO:  'submit_combo',
  PICK_WINNER:   'pick_winner',
  LEAVE_ROOM:    'leave_room',

  // --- сервер → клиент ---
  ROOM_STATE:    'room_state',
  YOUR_HAND:     'your_hand',
  PHASE_CHANGE:  'phase_change',
  SUBMISSIONS:   'submissions',
  REVEAL:        'reveal',
  SCORE_UPDATE:  'score_update',
  GAME_OVER:     'game_over',
  ERROR:         'error',
};

export const PHASES = {
  LOBBY:              'lobby',
  JUDGE_PICKS_PROMPT: 'judge_picks_prompt',
  PLAYERS_SUBMIT:     'players_submit',
  JUDGE_PICKS_WINNER: 'judge_picks_winner',
  REVEAL:             'reveal',
  GAME_OVER:          'game_over',
};

export const DEFAULTS = {
  MIN_PLAYERS:   3,
  MAX_PLAYERS:   10,
  HAND_SIZE:     7,
  COMBO_SIZE:    2,
  PROMPT_CHOICES: 3,
  REVEAL_DELAY:  6000,  // мс на показ раскрытия
  ROOM_TTL:      3600_000, // час — потом пустая комната удаляется
};