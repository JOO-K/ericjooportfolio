// ascii.js — joystick drives stormy directional fade (idle clears in ~3.5s via renderer)
// + AUDIO-REACTIVE GRID DOTS (fast): fill every non-silhouette grid cell with a tiny dot
//   in the *same* grid formation as the ASCII, pulsing to music.
//   • Bass + Kick → size pulses (punchy), tiny extra pop on kick edge
//   • Treble/Hats → micro jitter & sparkle
//   • Warmth (bass+kick vs treble) maps hue BLUE→ORANGE
//   • Only active when music is playing (or small idle drift)
//
// ASCII silhouette layer itself is unchanged.
// BG: gentle, desynced “wave” tint (independent undulation), with a *small* audio tint.

import { CONFIG } from './config.js';
import { hexToRgb } from './utils.js';
import { VideoPlaylist } from './playlist.js';
import { AsciiLayer } from './renderer.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a,b,t)=> a + (b-a) * clamp01(t);

// --- mask helpers ---
function brightnessAt(maskData, w, h, x, y) {
  if (!maskData) return 255;
  const xi = x | 0, yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 255;
  const i = (yi * w + xi) << 2;
  const a = maskData[i + 3]; if (a < 8) return 255;
  const r = maskData[i], g = maskData[i + 1], b = maskData[i + 2];
  return 0.2126*r + 0.7152*g + 0.0722*b;
}
const isInside = (md,w,h,x,y)=> brightnessAt(md,w,h,x,y) < CONFIG.VIDEO.SIL_BRIGHTNESS_THRESHOLD;

export class AsciiSilhouetteEffect {
  constructor() {
    this.name = 'ASCII Silhouette (Audio Grid Dots + Wavy BG)';

    // layout
    this.font = null;
    this.grid = CONFIG.GRID_DESKTOP;
    this.cols = 0;
    this.rows = 0;
    this._baseGrid = CONFIG.GRID_DESKTOP; // fixed; no joystick size changes now

    // layers / video
    this.ascii = null;
    this.video = null;
    this.maskData = null;

    // pointer (kept minimal)
    this.pX = -9999;
    this.pY = -9999;

    // ASCII cadence
    this.lastCharRefreshAt = 0;
    this.charTick = 0;

    // last dt for compositor
    this._lastDeltaMs = 16.7;

    // ===== Directional fade params from joystick =====
    this.vx = 0;                // unit direction x
    this.vy = 0;                // unit direction y
    this.trailStrength = 0;     // 0..1 (farther stick = longer trail)

    // subtle screen nudge toward wind (visual cue)
    this._hintTranslatePx = 0.9;

    // ===== Audio envelopes (from music.js __AUDIO_BUS) =====
    this._kEnv = 0; this._sEnv = 0; this._hEnv = 0; this._prevK = 0;
    this.K_ATTACK = 1.00; this.K_DECAY = 0.90;
    this.S_ATTACK = 0.85; this.S_DECAY = 0.93;
    this.H_ATTACK = 0.85; this.H_DECAY = 0.94;
    this._flash = 0; this.FLASH_DECAY = 0.86;

    // BG tint target (cool) + desynced “wave”
    this._bgBaseRGB = null;
    this._bgPulseRGB = { r: 150, g: 190, b: 255 };
    this._bgWavePhase = Math.random() * Math.PI * 2; // independent phase
    this.BG_WAVE_SPEED = 0.12;   // Hz-ish feel (seconds^-1 factor via sin(t*speed))
    this.BG_WAVE_DEPTH = 0.18;   // how deep the visual wave mixes toward pulse color

    // ===== Grid dots (no per-dot objects; fully procedural) =====
    this._cellCenters = null;   // [{x,y,gx,gy}, ...]
    this._haveCenters = false;
  }

  onJoystick({ x = 0, y = 0, mag = 0 } = {}) {
    const DEAD = 0.02;
    let xx = Math.abs(x) < DEAD ? 0 : x;
    let yy = Math.abs(y) < DEAD ? 0 : y;

    const len = Math.hypot(xx, yy);
    if (len > 1e-3) {
      this.vx = xx / len;
      this.vy = yy / len;
    } else {
      this.vx = 0; this.vy = 0;
    }

    // Aggressive curve so small pushes feel windy
    const eased = Math.pow(Math.max(0, Math.min(1, mag)), 0.9);
    this.trailStrength = Math.min(1, eased * 1.25);

    this.ascii?.setDirectionalFade?.({
      vx: this.vx, vy: this.vy, strength: this.trailStrength
    });
  }

  setParams() {}

  preload(p) {
    this.font = p.loadFont('fonts/Yarndings20-Regular.ttf', () => {}, () => {});
  }

  setup(p) {
    this._baseGrid = (p.windowWidth <= 800) ? CONFIG.GRID_MOBILE : CONFIG.GRID_DESKTOP;
    this._applyGridSize(p, this._baseGrid);

    const bgRgb = hexToRgb(CONFIG.BG_COLOR);
    this._bgBaseRGB = bgRgb;

    this.ascii = new AsciiLayer(p, this.grid, this.cols, this.rows, bgRgb);
    this.ascii.setFont(this.font);
    this.ascii.randomizePalette();

    this.ascii.setDirectionalFade?.({
      vx: this.vx, vy: this.vy, strength: this.trailStrength
    });

    const isMobile = p.windowWidth <= 800;
    this.video = new VideoPlaylist({ isMobile });
    this.video.init(p.width, p.height);

    this._attachPointer(p);
    this._buildGridCenters(p); // precompute grid centers for speed
  }

  dispose() {
    this.video?.dispose();
  }

  resize(p) {
    this._baseGrid = (p.windowWidth <= 800) ? CONFIG.GRID_MOBILE : CONFIG.GRID_DESKTOP;
    this._applyGridSize(p, this._baseGrid);

    this.ascii.setFont(this.font);
    this.ascii.randomizePalette();
    this.video?.resize(p.width, p.height);

    this._buildGridCenters(p);

    this.ascii.setDirectionalFade?.({
      vx: this.vx, vy: this.vy, strength: this.trailStrength
    });
  }

  // --- audio snapshot ---
  _audio() {
    const b = window.__AUDIO_BUS || {};
    const c = (v)=> clamp01(v ?? 0);
    return {
      playing: !!b.playing,
      rms: c(b.rms),
      bass: c(b.bands?.bass),
      lowMid: c(b.bands?.lowMid),
      mid: c(b.bands?.mid),
      highMid: c(b.bands?.highMid),
      treble: c(b.bands?.treble),
      k: c(b.kick), s: c(b.snare), h: c(b.hat),
    };
  }

  update(p, deltaMs) {
    this._lastDeltaMs = deltaMs;

    // refresh silhouette mask
    this.maskData = this.video.updateMask(p.width, p.height);

    // cadence
    if (p.millis() - this.lastCharRefreshAt >= CONFIG.CHAR_REFRESH_MS) {
      this.charTick++;
      this.lastCharRefreshAt = p.millis();
    }

    // audio envelopes
    const A = this._audio();
    const EDGE = 0.55;
    if (A.k > EDGE && this._prevK <= EDGE) { this._kEnv = 1.0; this._flash = 1.0; }
    this._prevK = A.k;
    this._kEnv = Math.max(this._kEnv * this.K_DECAY, A.k * this.K_ATTACK);
    this._sEnv = Math.max(this._sEnv * this.S_DECAY, A.s * this.S_ATTACK);
    this._hEnv = Math.max(this._hEnv * this.H_DECAY, A.h * this.H_ATTACK);
    this._flash *= this.FLASH_DECAY;
  }

  draw(p) {
    // ===== BG: independent wavy tint (desynced), with tiny audio tint =====
    const A = this._audio();
    const t = p.millis() * 0.001;
    const wave = 0.5 + 0.5 * Math.sin(t * (Math.PI * 2 * this.BG_WAVE_SPEED) + this._bgWavePhase);
    const waveMix = this.BG_WAVE_DEPTH * Math.pow(wave, 0.9); // smooth but alive

    // tiny audio contribution (kept small so motion feels independent)
    const audioMix = Math.min(0.06, 0.04 * (0.6*A.rms + 0.7*this._kEnv) + 0.02 * this._flash);

    const mix = Math.min(0.35, waveMix + audioMix);
    const bg = this._bgBaseRGB ? rgbLerp(this._bgBaseRGB, this._bgPulseRGB, mix) : hexToRgb(CONFIG.BG_COLOR);
    p.background(`rgb(${bg.r},${bg.g},${bg.b})`);

    // ===== AUDIO GRID DOTS (only in non-silhouette cells) =====
    this._drawAudioDots(p, A, t);

    // ===== ASCII layer (unchanged) =====
    this.ascii.draw(
      this.maskData,
      (mask, w, h, x, y) => this.video.isSilhouetteAt(mask, w, h, x, y),
      this.charTick
    );

    // immediately advect/decay and stamp (storm compositor)
    this.ascii.setDirectionalFade?.({
      vx: this.vx, vy: this.vy, strength: this.trailStrength
    });
    this.ascii.fadeDirectional?.(this._lastDeltaMs);

    // subtle screen nudge so direction reads
    const hint = this._hintTranslatePx * this.trailStrength;
    p.push();
    p.translate(this.vx * hint, this.vy * hint);
    this.ascii.blitTo(p);
    p.pop();
  }

  /* ---------------- Grid dots ---------------- */
  _buildGridCenters(p) {
    const cell = this.grid, half = cell * 0.5;
    const arr = [];
    for (let gy = 0; gy < this.rows; gy++) {
      const cy = gy * cell + half;
      for (let gx = 0; gx < this.cols; gx++) {
        const cx = gx * cell + half;
        arr.push({ x: cx, y: cy, gx, gy });
      }
    }
    this._cellCenters = arr;
    this._haveCenters = true;
  }

  _drawAudioDots(p, A, t) {
    if (!this._haveCenters || !this._cellCenters) return;

    // music features
    const kick = this._kEnv;
    const bass = A.bass;
    const treble = A.treble;
    const hats = this._hEnv;
    const rms = A.rms;

    // size & wobble model
    const baseDot = Math.max(1.0, this.grid * 0.18); // tiny base dot
    const sizeMul = 1.0 + 1.35*bass + 1.55*kick + 0.45*rms + 0.10*this._flash;
    const jitterAmp = 0.45 * (treble + hats);        // micro sparkle

    // hue: BLUE→ORANGE by warmth (bass+kick vs treble)
    const warmth = clamp01(0.65*bass + 0.90*kick - 0.55*treble + 0.15*this._flash);
    const HUE_BLUE = 210, HUE_ORANGE = 30;
    const hueBase = (HUE_BLUE + (HUE_ORANGE - HUE_BLUE) * warmth + 360) % 360;

    // alpha: stronger with energy but not opaque
    const alpha = Math.round(180 * clamp01(0.30 + 0.9*rms + 0.7*kick));

    p.push();
    p.noStroke();
    p.colorMode(p.HSL, 360, 100, 100, 255);
    p.fill(hueBase, Math.round(55 + 35*clamp01(rms + treble)), Math.round(60 + 15*(1-bass)), alpha);

    for (let i = 0; i < this._cellCenters.length; i++) {
      const c = this._cellCenters[i];
      const x = c.x, y = c.y;

      if (isInside(this.maskData, p.width, p.height, x, y)) continue; // ASCII occupies silhouette

      // deterministic pseudo-noise per cell → tiny jitter
      const ph = this._hash01(c.gx * 131 + c.gy * 269);
      const wob = Math.sin((c.gx*12.9898 + c.gy*78.233) * 0.05 + t*6.0 + ph*10.0) * jitterAmp;

      const r = Math.max(1.0, baseDot * (sizeMul + wob));
      const R = Math.min(this.grid * 0.9, r); // cap

      p.circle(x, y, R * 2);
    }
    p.pop();

    // (Note) Connecting lines explicitly removed per your request.
  }

  // tiny deterministic hash → [0,1]
  _hash01(n) {
    let x = (n | 0) ^ 0x9e3779b9;
    x = (x ^ (x >>> 16)) * 0x85ebca6b;
    x = (x ^ (x >>> 13)) * 0xc2b2ae35;
    x = (x ^ (x >>> 16)) >>> 0;
    return x / 4294967295;
  }

  // --- helpers ---
  _applyGridSize(p, gridPx) {
    this.grid = gridPx;
    this.cols = Math.floor(p.width / this.grid);
    this.rows = Math.floor(p.height / this.grid);
    if (this.ascii) this.ascii.resize(p, this.grid, this.cols, this.rows);
    this._haveCenters = false; // rebuild on next setup/resize
  }

  _attachPointer(p) {
    const canvas = p._renderer?.elt || p.canvas;
    const updatePointer = (x, y) => {
      const r = canvas.getBoundingClientRect();
      const sx = p.width / r.width, sy = p.height / r.height;
      this.pX = (x - r.left) * sx;
      this.pY = (y - r.top)  * sy;
    };
    canvas.addEventListener('pointermove', e => updatePointer(e.clientX, e.clientY), { passive: true });
    canvas.addEventListener('pointerenter', e => updatePointer(e.clientX, e.clientY), { passive: true });
    canvas.addEventListener('pointerleave', () => { this.pX = this.pY = -9999; }, { passive: true });
  }
}

// small local rgb lerp
function rgbLerp(a, b, t){
  return {
    r: Math.round(lerp(a.r, b.r, t)),
    g: Math.round(lerp(a.g, b.g, t)),
    b: Math.round(lerp(a.b, b.b, t)),
  };
}

export default AsciiSilhouetteEffect;
