// ============================================================
// Общий контракт клиент ↔ сервер
// ============================================================

export const EVENTS = {
  // --- клиент → сервер ---
  CREATE_ROOM:      'create_room',
  JOIN_ROOM:        'join_room',
  REJOIN:           'rejoin',
  START_GAME:       'start_game',
  PICK_PROMPT:      'pick_prompt',
  SUBMIT_COMBO:     'submit_combo',
  PICK_WINNER:      'pick_winner',
  LEAVE_ROOM:       'leave_room',

  // --- аутентификация ---
  AUTH:             'auth',            // проверка токена при подключении
  REGISTER:         'register',        // регистрация
  LOGIN:            'login',           // вход
  LOGOUT:           'logout',          // выход
  GUEST:            'guest',           // войти как гость (только имя)

  // --- профиль и рейтинг ---
  GET_PROFILE:      'get_profile',     // статистика юзера
  GET_LEADERBOARD:  'get_leaderboard', // топ-20 (score|wins|winrate)
  PROFILE_DATA:     'profile_data',
  LEADERBOARD_DATA: 'leaderboard_data',

  // --- сервер → клиент ---
  ROOM_STATE:       'room_state',
  YOUR_HAND:        'your_hand',
  PHASE_CHANGE:     'phase_change',
  SUBMISSIONS:      'submissions',
  REVEAL:           'reveal',
  SCORE_UPDATE:     'score_update',
  GAME_OVER:        'game_over',
  TIMER_TICK:       'timer_tick',
  ERROR:            'error',
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
  REVEAL_DELAY:      8000,
  ROOM_TTL:          3600_000,
  DISCONNECT_GRACE:  60_000,

  // --- аккаунты ---
  SESSION_TTL:       30 * 24 * 3600,   // 30 дней в секундах
  USERNAME_MIN:      3,
  USERNAME_MAX:      20,
  PASSWORD_MIN:      6,
  PASSWORD_MAX:      72,
};

export const DURATIONS = {
  JUDGE_PICKS_PROMPT: 30_000,
  PLAYERS_SUBMIT:     90_000,
  JUDGE_PICKS_WINNER: 30_000,
};

export const LEADERBOARD_TYPES = ['score', 'wins', 'winrate'];
export const LEADERBOARD_LIMIT = 20;