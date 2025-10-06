// videomosaic.js — Panels with fluid repacks + AUDIO-REACTIVE polish (NO FADE VERSION)
// Joystick: gravity + directional "punch" impulses that push panels, which then spring back.
//
// Audio additions (gentle & non-jarring):
//  • Repack cadence breathes with energy (faster on peaks, slower at rest)
//  • Panel fill hue sweeps BLUE→ORANGE by “warmth” (bass+kick vs treble), low alpha to avoid glare
//  • Size pulse on bass/kick (subtle 0–8%), tiny jitter on hats (≤2px), micro flash on kick edge
//  • Stroke alpha reduced overall; stroke weight steady so it stays crisp
//
// CHANGE: Afterimage/trail fade is DISABLED. We hard-clear the layer every frame (no accumulation).

import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';
import { hexToRgb } from './utils.js';

/* ----------------- mask helpers ----------------- */
function brightnessAt(maskData, w, h, x, y) {
  if (!maskData) return 255;
  const xi = x | 0, yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 255;
  const i = (yi * w + xi) << 2;
  const a = maskData[i + 3]; if (a < 8) return 255;
  const r = maskData[i], g = maskData[i + 1], b = maskData[i + 2];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function isInside(maskData, w, h, x, y) {
  return brightnessAt(maskData, w, h, x, y) < CONFIG.VIDEO.SIL_BRIGHTNESS_THRESHOLD;
}
const smoothstep = (t) => (t<=0?0:t>=1?1:t*t*(3-2*t));
const clamp01 = (v)=>Math.max(0, Math.min(1, v));
const lerp = (a,b,t)=>a+(b-a)*t;

/* ----------------- effect ----------------- */
export default class VideoMosaicPanelsEffect {
  constructor(opts = {}) {
    this.name = 'Video Mosaic Panels (Fluid + Gaps + Joystick Physics + Audio, No Fade)';

    this.video = opts.playlist || null;
    this._ownsVideo = !this.video;
    this.maskData = null;

    // grid
    this.baseGrid       = CONFIG.GRID_DESKTOP * 0.9;
    this.baseGridMobile = CONFIG.GRID_MOBILE * 1.0;
    this.grid = this.baseGrid;
    this.cols = 0;
    this.rows = 0;

    // tiling
    this.tileSizes   = [1, 2, 3];
    this.tileWeights = [0.56, 0.30, 0.14];

    // look (softened to be less jarring)
    this.GAP_PX        = 2;
    this.panelCorner   = 6;
    this.panelFill     = [20, 20, 24];     // base RGB, we tint with HSL on draw
    this.strokeColor   = [255, 255, 255];
    this.strokeA       = 120;              // reduced alpha
    this.strokeW       = 0.6;              // crisp but subtle

    // repack tween
    this.REPACK_PERIOD_MS_BASE = 540;      // slightly slower idle
    this.REPACK_TWEEN_MS       = 420;
    this._lastPackAt      = 0;
    this._tweenStartAt    = 0;
    this._tweenActive     = false;

    // no-fade layer (we clear it fully each frame)
    this.trail = null;
    this.bgRgb = hexToRgb(CONFIG.BG_COLOR);

    // panel list
    this.panels = [];
    this._seed = 1337;

    // ---------- Joystick physics ----------
    this._jx = 0;   // -1..1
    this._jy = 0;   // -1..1
    this._jmag = 0; // 0..1
    this._jactive = false;

    // physics params (snap + settle)
    this.SPRING_K    = 24.0;
    this.DAMPING     = 6.0;
    this.GRAVITY_MAX = 1800;
    this.PUNCH_IMP   = 900;
    this.PUNCH_JITTER= 0.25;
    this.PUNCH_EVERY = 160;
    this._lastPunchAt= 0;

    this._prevMag = 0;

    // ---------- Audio envelopes ----------
    this._kEnv = 0; this._sEnv = 0; this._hEnv = 0; this._prevK = 0;
    this.K_ATTACK = 1.00; this.K_DECAY = 0.90;
    this.S_ATTACK = 0.85; this.S_DECAY = 0.93;
    this.H_ATTACK = 0.85; this.H_DECAY = 0.94;
    this._flash = 0; this.FLASH_DECAY = 0.86;

    // color (HSL) span for fills
    this.HUE_BLUE   = 210;
    this.HUE_ORANGE = 30;

    // cached per-frame audio snapshot
    this._A = {
      playing:false, rms:0, k:0, s:0, h:0,
      bands: { bass:0, mid:0, treble:0 }
    };
  }

  onJoystick({ x = 0, y = 0, mag = 0, active = false } = {}) {
    this._jx = Math.max(-1, Math.min(1, x));
    this._jy = Math.max(-1, Math.min(1, y));
    this._jmag = Math.max(0, Math.min(1, mag));
    this._jactive = !!active || this._jmag > 0.1;
  }

  preload(p) {}

  setup(p) {
    this._applyGrid(p);

    if (this._ownsVideo) {
      const isMobile = p.windowWidth <= 800;
      this.video = new VideoPlaylist({ isMobile });
      this.video.init(p.width, p.height);
    } else {
      this.video?.resize?.(p.width, p.height);
    }

    this.trail = p.createGraphics(p.width, p.height);
    this.trail.noStroke();

    this.panels = [];
    this._lastPackAt = 0;
    this._tweenActive = false;

    p.strokeCap(p.ROUND);
    p.strokeJoin(p.ROUND);
  }

  dispose() { if (this._ownsVideo) this.video?.dispose?.(); }

  resize(p) {
    this.video?.resize?.(p.width, p.height);
    this._applyGrid(p);
    this.trail = p.createGraphics(p.width, p.height);
    this.trail.noStroke();
    this.panels = [];
    this._lastPackAt = 0;
    this._tweenActive = false;
  }

  _applyGrid(p) {
    this.grid = (p.windowWidth <= 800) ? this.baseGridMobile : this.baseGrid;
    this.cols = Math.max(1, Math.floor(p.width  / this.grid));
    this.rows = Math.max(1, Math.floor(p.height / this.grid));
  }

  _rand() {
    let x = this._seed |= 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._seed = x;
    return ((x >>> 0) / 4294967296);
  }
  _choiceWeighted(vals, weights) {
    const t = weights.reduce((a,b)=>a+b,0);
    let r = this._rand() * t;
    for (let i=0;i<vals.length;i++){ r -= weights[i]; if (r<=0) return vals[i]; }
    return vals[vals.length-1];
  }

  _resetOcc() {
    this.occ = Array.from({ length: this.rows }, () => Array(this.cols).fill(false));
  }
  _canPlace(c, r, w, h) {
    if (c < 0 || r < 0 || c + w > this.cols || r + h > this.rows) return false;
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++)
      if (this.occ[y][x]) return false;
    return true;
  }
  _place(c, r, w, h) {
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) this.occ[y][x] = true;
  }
  _panelRect(c, r, w, h) {
    const x  = c * this.grid;
    const y  = r * this.grid;
    const pw = w * this.grid;
    const ph = h * this.grid;
    return { x, y, pw, ph };
  }

  _packNow(p) {
    if (!this.maskData) return [];

    this._resetOcc();
    const out = [];

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.occ[r][c]) continue;

        const trySizes = [3,2,1].filter(sz => this.tileSizes.includes(sz));
        let placed = false;
        for (let s of trySizes) {
          if (!this._canPlace(c, r, s, s)) continue;
          const cx = (c + s * 0.5) * this.grid;
          const cy = (r + s * 0.5) * this.grid;
          if (!isInside(this.maskData, p.width, p.height, cx, cy)) continue;

          out.push({ c, r, w: s, h: s, ...this._panelRect(c, r, s, s) });
          this._place(c, r, s, s);
          placed = true; break;
        }

        if (!placed) {
          const s = this._choiceWeighted(this.tileSizes, this.tileWeights);
          if (this._canPlace(c, r, s, s)) {
            const cx = (c + s * 0.5) * this.grid;
            const cy = (r + s * 0.5) * this.grid;
            if (isInside(this.maskData, p.width, p.height, cx, cy)) {
              out.push({ c, r, w: s, h: s, ...this._panelRect(c, r, s, s) });
              this._place(c, r, s, s);
            }
          }
        }
      }
    }
    return out;
  }

  _beginTweenTo(nextList, p) {
    const curr = this.panels;
    const next = nextList;
    const nMin = Math.min(curr.length, next.length);

    for (let i = 0; i < nMin; i++) {
      const a = curr[i], b = next[i];
      a.sx = a.x;  a.sy = a.y;  a.sw = a.pw; a.sh = a.ph; a.sa = a._alpha ?? 255;
      a.tx = b.x;  a.ty = b.y;  a.tw = b.pw; a.th = b.ph; a.ta = 255;
    }
    for (let i = nMin; i < curr.length; i++) {
      const a = curr[i];
      a.sx = a.x;  a.sy = a.y;  a.sw = a.pw; a.sh = a.ph; a.sa = a._alpha ?? 255;
      a.tx = a.x + a.pw * 0.5; a.ty = a.y + a.ph * 0.5; a.tw = 0; a.th = 0; a.ta = 0;
    }
    const spawns = [];
    for (let i = nMin; i < next.length; i++) {
      const b = next[i];
      spawns.push({
        c: b.c, r: b.r, w: b.w, h: b.h,
        x: b.x, y: b.y, pw: b.pw, ph: b.ph,
        sx: b.x + b.pw * 0.5, sy: b.y + b.ph * 0.5, sw: 0, sh: 0, sa: 0,
        tx: b.x, ty: b.y, tw: b.pw, th: b.ph, ta: 255,
        _alpha: 0,
        ox: 0, oy: 0, vx: 0, vy: 0
      });
    }
    this.panels.length = Math.min(this.panels.length, nMin);
    this.panels.push(...spawns);

    this._tweenActive  = true;
    this._tweenStartAt = p.millis();
  }

  _tweenStep(p) {
    if (!this._tweenActive) return;
    const t = Math.min(1, (p.millis() - this._tweenStartAt) / this.REPACK_TWEEN_MS);
    const k = smoothstep(t);

    for (const a of this.panels) {
      a.x  = a.sx + (a.tx - a.sx) * k;
      a.y  = a.sy + (a.ty - a.sy) * k;
      a.pw = a.sw + (a.tw - a.sw) * k;
      a.ph = a.sh + (a.th - a.sh) * k;
      a._alpha = a.sa + (a.ta - a.sa) * k;
    }

    if (t >= 1) {
      this._tweenActive = false;
      for (const a of this.panels) {
        a.x = a.tx; a.y = a.ty; a.pw = a.tw; a.ph = a.th; a._alpha = a.ta;
        delete a.sx; delete a.sy; delete a.sw; delete a.sh; delete a.sa;
        delete a.tx; delete a.ty; delete a.tw; delete a.th; delete a.ta;
      }
      this.panels = this.panels.filter(pn => pn.pw > 0.5 && pn.ph > 0.5 && (pn._alpha ?? 255) > 1);
    }
  }

  _ensurePhysicsState(pan) {
    if (pan.ox === undefined) { pan.ox = 0; pan.oy = 0; pan.vx = 0; pan.vy = 0; }
  }

  _applyPunch(nowMs, strength = 1.0) {
    const j = Math.max(0.25, 1 + (Math.random()*2 - 1) * this.PUNCH_JITTER);
    const impX = this.PUNCH_IMP * this._jx * j * strength;
    const impY = this.PUNCH_IMP * this._jy * j * strength;
    for (const pan of this.panels) {
      this._ensurePhysicsState(pan);
      pan.vx += impX;
      pan.vy += impY;
    }
    this._lastPunchAt = nowMs;
  }

  _audio() {
    const b = window.__AUDIO_BUS || {};
    const c = (v)=> clamp01(v ?? 0);
    return {
      playing: !!b.playing,
      rms: c(b.rms),
      k: c(b.kick), s: c(b.snare), h: c(b.hat),
      bands: {
        bass:   c(b.bands?.bass),
        mid:    c(b.bands?.mid),
        treble: c(b.bands?.treble),
      }
    };
  }

  update(p, dtMs) {
    // --- audio envelopes ---
    this._A = this._audio();
    const A = this._A;

    const EDGE = 0.55;
    if (A.k > EDGE && this._prevK <= EDGE) { this._kEnv = 1.0; this._flash = 1.0; }
    this._prevK = A.k;

    this._kEnv = Math.max(this._kEnv * this.K_DECAY, A.k * this.K_ATTACK);
    this._sEnv = Math.max(this._sEnv * this.S_DECAY, A.s * this.S_ATTACK);
    this._hEnv = Math.max(this._hEnv * this.H_DECAY, A.h * this.H_ATTACK);
    this._flash *= this.FLASH_DECAY;

    const energy = clamp01(0.55*A.rms + 0.65*A.bands.bass + 0.55*this._kEnv);

    // NO FADE: clear the layer fully (no accumulation)
    this.trail.clear();
    this.trail.background(this.bgRgb.r, this.bgRgb.g, this.bgRgb.b);

    // mask refresh
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;

    // seed on first frame with physics init
    if (this.panels.length === 0 && this.maskData) {
      this._seed = (Math.random() * 1e9) | 0;
      const first = this._packNow(p);
      this.panels = first.map(b => ({
        c: b.c, r: b.r, w: b.w, h: b.h,
        x: b.x, y: b.y, pw: b.pw, ph: b.ph,
        sx: b.x + b.pw * 0.5, sy: b.y + b.ph * 0.5, sw: 0, sh: 0, sa: 0,
        tx: b.x, ty: b.y, tw: b.pw, th: b.ph, ta: 255,
        _alpha: 0,
        ox: 0, oy: 0, vx: 0, vy: 0
      }));
      this._tweenActive  = true;
      this._tweenStartAt = p.millis();
      this._lastPackAt   = p.millis();
    }

    // periodic repack (audio-reactive): faster on peaks, slower at rest
    const period = this.REPACK_PERIOD_MS_BASE * (1.15 - 0.55*energy);
    const nowMs = p.millis();
    if (this.maskData && nowMs - this._lastPackAt >= period && !this._tweenActive) {
      this._seed = (Math.random() * 1e9) | 0;
      const next = this._packNow(p);
      this._beginTweenTo(next, p);
      this._lastPackAt = nowMs;
    }

    // tween positions
    this._tweenStep(p);

    // --------- physics: gravity + spring + punch ----------
    const gScale = this.GRAVITY_MAX * this._jmag;
    const gx = this._jx * gScale;
    const gy = this._jy * gScale;

    if (this._jactive && (nowMs - this._lastPunchAt) >= this.PUNCH_EVERY) {
      this._applyPunch(nowMs, 0.8 + 0.6*energy);
    }

    const magDelta = this._jmag - this._prevMag;
    if (magDelta > 0.22) {
      this._applyPunch(nowMs, 0.8 + 0.6*energy);
    }
    this._prevMag = this._jmag;

    const dt = Math.max(0.001, (dtMs || 16.7));
    const dtSec = dt / 1000;
    for (const pan of this.panels) {
      this._ensurePhysicsState(pan);

      const fx = -this.SPRING_K * pan.ox - this.DAMPING * pan.vx + gx;
      const fy = -this.SPRING_K * pan.oy - this.DAMPING * pan.vy + gy;

      pan.vx += fx * dtSec;
      pan.vy += fy * dtSec;

      pan.ox += pan.vx * dtSec;
      pan.oy += pan.vy * dtSec;

      const vmax = 2200;
      if (pan.vx >  vmax) pan.vx =  vmax; else if (pan.vx < -vmax) pan.vx = -vmax;
      if (pan.vy >  vmax) pan.vy =  vmax; else if (pan.vy < -vmax) pan.vy = -vmax;
      const omax = Math.max(p.width, p.height) * 0.75;
      if (pan.ox >  omax) pan.ox =  omax; else if (pan.ox < -omax) pan.ox = -omax;
      if (pan.oy >  omax) pan.oy =  omax; else if (pan.oy < -omax) pan.oy = -omax;
    }
  }

  draw(p) {
    // draw onto the cleared layer (trail)
    const g = this.trail;
    const gap = this.GAP_PX;

    g.push();
    g.colorMode(p.HSL, 360, 100, 100, 255);

    // music-driven tint & size pulse (subtle)
    const A = this._A;
    const warmth = clamp01(0.60*A.bands.bass + 0.90*this._kEnv - 0.55*A.bands.treble + 0.20*this._flash);
    const hue    = (this.HUE_BLUE + (this.HUE_ORANGE - this.HUE_BLUE) * warmth + 360) % 360;
    const sat    = Math.min(85, 45 + Math.round(40 * clamp01(A.rms + 0.4*this._kEnv)));
    const lig    = Math.min(75, 58 + Math.round(12 * (1 - A.bands.bass)));
    const fillA  = Math.round(90 + 70 * clamp01(A.rms + 0.6*this._kEnv));
    const grow   = Math.min(0.08, 0.05*A.bands.bass + 0.06*this._kEnv + 0.02*A.rms);
    const jitter = Math.min(2.0, 2.0 * (0.6*this._hEnv + 0.3*A.bands.treble));

    g.stroke(this.strokeColor[0], this.strokeColor[1], this.strokeColor[2], this.strokeA);
    g.strokeWeight(this.strokeW);

    for (let i = 0; i < this.panels.length; i++) {
      const pan = this.panels[i];
      if (pan.pw <= 0.5 || pan.ph <= 0.5) continue;

      const ox = (pan.ox || 0);
      const oy = (pan.oy || 0);

      const cx = pan.x + ox + pan.pw * 0.5;
      const cy = pan.y + oy + pan.ph * 0.5;
      const pw = pan.pw * (1 + grow);
      const ph = pan.ph * (1 + grow);

      const x  = cx - pw * 0.5 + gap * 0.5 + (Math.random()*2-1) * jitter;
      const y  = cy - ph * 0.5 + gap * 0.5 + (Math.random()*2-1) * jitter;
      const rw = Math.max(0, pw - gap);
      const rh = Math.max(0, ph - gap);

      const a = (pan._alpha ?? 255);

      g.noStroke();
      g.fill(hue, sat, lig, Math.min(fillA, a));
      g.rect(x, y, rw, rh, this.panelCorner);

      g.noFill();
      g.stroke(this.strokeColor[0], this.strokeColor[1], this.strokeColor[2], Math.min(this.strokeA, a));
      g.rect(x, y, rw, rh, this.panelCorner);
    }
    g.pop();

    // composite: since layer is already backgrounded, just blit
    p.image(this.trail, 0, 0);
  }
}
