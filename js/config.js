export const CONFIG = {
  BG_COLOR: '#0e111a',
  GRID_DESKTOP: 20,
  GRID_MOBILE: 8,

  CHARSET: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@$%&*+•◦=<>/^~░▒▓█",
  CHAR_REFRESH_MS: 220,          // small bump; calmer cadence
  ASCII_FADE_TAU_MS: 220,        // fade a bit slower so words persist

  POETRY_FONT_FAMILY: 'DM Mono',   // ✅ now using DM Mono
  POETRY_DEFAULT_WORDS: [
    'time','echo','glass','memory','horizon','fall','drift','light','shadow',
    'breath','pulse','signal','thread','river','field','tremor','grain','orbit',
    'silent','return','becoming','between','again','never','always'
  ],

  VIDEO: {
    // ↓ Slightly higher tolerance so more pixels count as silhouette.
    SIL_BRIGHTNESS_THRESHOLD: 190,
    SIL_SCALE: 0.92,             // a bit larger so it reads
    UPDATE_PERIOD: 3,
    UPDATE_ACTIVE: 2,
    DESKTOP_PLAYLIST: [
      ['/videos/rose.mp4', '/videos/horse2.webm'],
      ['/videos/tree.mp4'],
      ['/videos/horse2.mp4']
    ],
    MOBILE_PLAYLIST: [['/videos/mobile.mp4']],
  },

  DRIPS: {
    STEP_MS_MIN: 60, STEP_MS_MAX: 120, MAX_STEPS_PER_UPDATE: 6,
    START_ROW_MIN: -8,
    SEGMENT_FADE_MS: 1200, SEGMENT_FADE_DELAY_FACTOR: 0.50,
    FINAL_FADE_DELAY_MS: 200, FINAL_FADE_MS: 600,
    CLICK_SPAWN_COUNT: 2, CLICK_SCATTER_COLS: 1,
    MAX_SIZE: 9, GROWTH_START: 0.00, GROWTH_EASE: 0.7
  },

  IMAGES: { prefix: 'images/hp_', suffix: '.png', count: 120 },

  // Optional: turn on a green debug outline of the silhouette sampling.
  DEBUG_SILHOUETTE: false,
};
