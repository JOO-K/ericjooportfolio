// videomosaic.js — Panels with fluid repacks + afterimage
// Joystick: gravity + directional "punch" impulses that push panels, which then spring back.

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

/* ----------------- effect ----------------- */
export default class VideoMosaicPanelsEffect {
  constructor(opts = {}) {
    this.name = 'Video Mosaic Panels (Fluid + Gaps + Afterimage + Joystick Physics)';

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

    // look
    this.GAP_PX        = 2;
    this.panelCorner   = 6;
    this.panelFill     = [20, 20, 24];
    this.strokeColor   = [255, 255, 255];
    this.strokeA       = 255;
    this.strokeW       = 0.5;

    // repack tween
    this.REPACK_PERIOD_MS = 500;
    this.REPACK_TWEEN_MS  = 420;
    this._lastPackAt      = 0;
    this._tweenStartAt    = 0;
    this._tweenActive     = false;

    // afterimage trail
    this.TRAIL_TAU_MS = CONFIG.ASCII_FADE_TAU_MS || 220;
    this.trail = null;
    this.bgRgb = hexToRgb(CONFIG.BG_COLOR);

    // panel list
    this.panels = [];
    this._seed = 1337;

    // ---------- Joystick physics ----------
    // global joystick state (fed by app.js via onJoystick)
    this._jx = 0;   // -1..1
    this._jy = 0;   // -1..1
    this._jmag = 0; // 0..1
    this._jactive = false;

    // physics params (tuned for snap + settle)
    this.SPRING_K    = 24.0;  // spring back to packed target
    this.DAMPING     = 6.0;   // velocity damping
    this.GRAVITY_MAX = 1800;  // px/s^2 at full joystick deflection
    this.PUNCH_IMP   = 900;   // px/s impulse per punch (applied to vx, vy)
    this.PUNCH_JITTER= 0.25;  // randomization of impulse ±25%
    this.PUNCH_EVERY = 160;   // ms between auto-punches while held
    this._lastPunchAt= 0;

    // to detect "shove" when the stick is yanked outward quickly
    this._prevMag = 0;
  }

  // Joystick input from app.js (called every frame)
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

    // match existing to new + shrink rest
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
        // physics state
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
      // prune collapsed
      this.panels = this.panels.filter(pn => pn.pw > 0.5 && pn.ph > 0.5 && (pn._alpha ?? 255) > 1);
    }
  }

  /* ---------- physics helpers ---------- */
  _ensurePhysicsState(pan) {
    if (pan.ox === undefined) { pan.ox = 0; pan.oy = 0; pan.vx = 0; pan.vy = 0; }
  }

  _applyPunch(nowMs) {
    const j = Math.max(0.25, 1 + (Math.random()*2 - 1) * this.PUNCH_JITTER);
    const impX = this.PUNCH_IMP * this._jx * j;
    const impY = this.PUNCH_IMP * this._jy * j;
    for (const pan of this.panels) {
      this._ensurePhysicsState(pan);
      pan.vx += impX;
      pan.vy += impY;
    }
    this._lastPunchAt = nowMs;
  }

  update(p, dtMs) {
    // Fade trail
    const dt = Math.max(0.001, (dtMs || 16.7));         // ms
    const dtSec = dt / 1000;
    const a = 255 * (1 - Math.exp(-dt / this.TRAIL_TAU_MS));
    this.trail.push();
    this.trail.noStroke();
    this.trail.fill(this.bgRgb.r, this.bgRgb.g, this.bgRgb.b, a);
    this.trail.rect(0, 0, this.trail.width, this.trail.height);
    this.trail.pop();

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

    // periodic repack → tween
    const nowMs = p.millis();
    if (this.maskData && nowMs - this._lastPackAt >= this.REPACK_PERIOD_MS && !this._tweenActive) {
      this._seed = (Math.random() * 1e9) | 0;
      const next = this._packNow(p);
      this._beginTweenTo(next, p);
      this._lastPackAt = nowMs;
    }

    // tween positions
    this._tweenStep(p);

    // --------- physics: gravity + spring + punch ----------
    const gScale = this.GRAVITY_MAX * this._jmag;   // accel magnitude
    const gx = this._jx * gScale;
    const gy = this._jy * gScale;

    // auto-punch while held every PUNCH_EVERY ms
    if (this._jactive && (nowMs - this._lastPunchAt) >= this.PUNCH_EVERY) {
      this._applyPunch(nowMs);
    }

    // extra punch when the stick is yanked outward quickly
    const magDelta = this._jmag - this._prevMag;
    if (magDelta > 0.22) {
      this._applyPunch(nowMs);
    }
    this._prevMag = this._jmag;

    // integrate per panel
    for (const pan of this.panels) {
      this._ensurePhysicsState(pan);

      // spring to target (0,0 offset)
      const fx = -this.SPRING_K * pan.ox - this.DAMPING * pan.vx + gx;
      const fy = -this.SPRING_K * pan.oy - this.DAMPING * pan.vy + gy;

      pan.vx += fx * dtSec;
      pan.vy += fy * dtSec;

      pan.ox += pan.vx * dtSec;
      pan.oy += pan.vy * dtSec;

      // very soft clamp to avoid runaway
      const vmax = 2200;
      if (pan.vx >  vmax) pan.vx =  vmax; else if (pan.vx < -vmax) pan.vx = -vmax;
      if (pan.vy >  vmax) pan.vy =  vmax; else if (pan.vy < -vmax) pan.vy = -vmax;
      // keep offsets bounded (in case of long held punch)
      const omax = Math.max(p.width, p.height) * 0.75;
      if (pan.ox >  omax) pan.ox =  omax; else if (pan.ox < -omax) pan.ox = -omax;
      if (pan.oy >  omax) pan.oy =  omax; else if (pan.oy < -omax) pan.oy = -omax;
    }
  }

  draw(p) {
    const g = this.trail;
    const gap = this.GAP_PX;

    g.push();
    g.stroke(this.strokeColor[0], this.strokeColor[1], this.strokeColor[2], this.strokeA);
    g.strokeWeight(this.strokeW);

    for (let i = 0; i < this.panels.length; i++) {
      const pan = this.panels[i];
      if (pan.pw <= 0.5 || pan.ph <= 0.5) continue;

      const ox = pan.ox || 0, oy = pan.oy || 0;

      const x  = pan.x + ox + gap * 0.5;
      const y  = pan.y + oy + gap * 0.5;
      const pw = Math.max(0, pan.pw - gap);
      const ph = Math.max(0, pan.ph - gap);

      const a = (pan._alpha ?? 255);
      g.noFill();
      g.fill(this.panelFill[0], this.panelFill[1], this.panelFill[2], Math.min(140, a * 0.55));
      g.rect(x, y, pw, ph, this.panelCorner);
      g.noFill();
      g.stroke(this.strokeColor[0], this.strokeColor[1], this.strokeColor[2], a);
      g.rect(x, y, pw, ph, this.panelCorner);
    }
    g.pop();

    p.background(this.bgRgb.r, this.bgRgb.g, this.bgRgb.b);
    p.image(this.trail, 0, 0);
  }
}
