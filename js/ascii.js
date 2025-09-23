// ascii.js — joystick drives stormy directional fade (idle clears in ~3.5s via renderer)

import { CONFIG } from './config.js';
import { hexToRgb } from './utils.js';
import { VideoPlaylist } from './playlist.js';
import { AsciiLayer } from './renderer.js';

export class AsciiSilhouetteEffect {
  constructor() {
    this.name = 'ASCII Silhouette (No Drips)';
    this.font = null;

    // layout
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

    this.ascii.setDirectionalFade?.({
      vx: this.vx, vy: this.vy, strength: this.trailStrength
    });
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
  }

  draw(p) {
    p.background(CONFIG.BG_COLOR);

    // draw this frame’s ASCII into the frame buffer
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

  // --- helpers ---
  _applyGridSize(p, gridPx) {
    this.grid = gridPx;
    this.cols = Math.floor(p.width / this.grid);
    this.rows = Math.floor(p.height / this.grid);
    if (this.ascii) this.ascii.resize(p, this.grid, this.cols, this.rows);
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

export default AsciiSilhouetteEffect;
