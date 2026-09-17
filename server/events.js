export const EVENTS = {
  CREATE_ROOM:   'create_room',
  JOIN_ROOM:     'join_room',
  REJOIN:        'rejoin',
  START_GAME:    'start_game',
  PICK_PROMPT:   'pick_prompt',
  SUBMIT_COMBO:  'submit_combo',
  PICK_WINNER:   'pick_winner',
  LEAVE_ROOM:    'leave_room',

  ROOM_STATE:    'room_state',
  YOUR_HAND:     'your_hand',
  PHASE_CHANGE:  'phase_change',
  SUBMISSIONS:   'submissions',
  REVEAL:        'reveal',
  SCORE_UPDATE:  'score_update',
  GAME_OVER:     'game_over',
  TIMER_TICK:    'timer_tick',
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
  MIN_PLAYERS:       2,
  MAX_PLAYERS:       10,
  HAND_SIZE:         7,
  COMBO_SIZE:        2,
  PROMPT_CHOICES:    3,
  REVEAL_DELAY:      8000,     // 8 сек на показ раскрытия
  ROOM_TTL:          3600_000,
  DISCONNECT_GRACE:  60_000,
};

export const DURATIONS = {
  JUDGE_PICKS_PROMPT: 30_000,   // 30 сек на выбор задания
  PLAYERS_SUBMIT:     90_000,   // 90 сек на выбор комбо
  JUDGE_PICKS_WINNER: 30_000,   // 30 сек на выбор победителя
};