// videobezier.js — Glowing Bezier outline of the video silhouette (stacky fade).
// Click = glow burst.
//
// LINGER + JOYSTICK:
//  • Up/Down   -> linger amount (slower/faster fade of the accumulated trails)
//  • Left (<0) -> more chaos: stronger curve noise/jitter
//  • Right(>0) -> longer chains: more segments per stroke + longer segment length
//                 AND dynamically *reduce* stroke spawn to protect performance.
//
// Old strokes do not move; they linger in trails and fade based on joystick.

import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';
import { hexToRgb } from './utils.js';

// === TINY TOGGLES ===
const FADE_TO_BG = true;    // fade towards CONFIG.BG_COLOR (not hard black)
const MONOCHROME = false;   // true = pure white strokes (no hue drift)

// === STACKY TRAIL FEEL (defaults; joystick remaps live each frame) ===
const DEFAULT_STACKY_DECAY_EVERY = 3;   // fade only every N frames (lets brightness accumulate)
const DEFAULT_TRAIL_FADE_ALPHA   = 10;  // alpha of the decay rectangle
const BLUR_EVERY         = 6;           // gentle blur cadence (0 = off)
const BLUR_AMT           = 0.6;         // blur radius

// === DENSITY BASELINES (desktop vs mobile) ===
const DESK_STROKES_BASE = 60;
const DESK_STROKES_MAX  = 150;

const MOB_STROKES_BASE  = 42;
const MOB_STROKES_MAX   = 96;

// Left (<0) chaos knobs
const NOISE_BASE   = 0.18; // CURVE_NOISE baseline
const NOISE_MAX    = 0.55; // at full left deflection
const JITTER_BASE  = 0.0;  // extra random pixel jitter baseline
const JITTER_MAX   = 28.0; // at full left deflection

// Right (>0) chain knobs
const CHAINS_MAX_SEGMENTS = 5;    // extra segments (1 base + up to this many)
const LEN_BOOST_MAX       = 2.6;  // segment length multiplier at full right

// When chains get longer, reduce strokes to protect perf
// e.g. at full-right with max length/segments → cut up to 60% (desktop) / 70% (mobile)
const RIGHT_STROKE_REDUCTION_MAX_DESK = 0.60;
const RIGHT_STROKE_REDUCTION_MAX_MOB  = 0.70;

// === LINGER RANGE (mapped from Up/Down) ===
const DECAY_EVERY_MIN = 2;  // decay every 2 frames (shorter linger)
const DECAY_EVERY_MAX = 8;  // decay every 8 frames (longer linger)
const TRAIL_ALPHA_MIN = 3;  // very slow fade
const TRAIL_ALPHA_MAX = 18; // faster fade

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

export default class VideoBezierOutlineEffect {
  constructor() {
    this.name = 'Video Bezier Silhouette (Stacky + Linger + Chains LR w/ Auto Throttle)';

    // video/mask
    this.video = null;
    this.maskData = null;

    // edge sampling
    this.SAMPLE_STEP = 6;
    this.EDGE_POINTS_MAX = 2400;

    // stroke gen (baseline; we modulate per-frame via joystick)
    this.STROKES_PER_FRAME = 90;
    this.CURVE_LEN_MIN = 30;
    this.CURVE_LEN_MAX = 120;
    this.CURVE_NOISE   = 0.22;   // used as a base; actual noise set each frame

    // trails & base glow
    this.trails = null;
    this.TRAIL_FADE = DEFAULT_TRAIL_FADE_ALPHA;
    this.BASE_WEIGHT = 1.1;
    this.BASE_ALPHA  = 90;

    // click glow
    this._flareUntil = 0;
    this._flareX = 0; this._flareY = 0;
    this.FLARE_MS     = 900;
    this.FLARE_WEIGHT = 3.2;
    this.FLARE_ALPHA  = 255;
    this.FLARE_RADIUS = 260;

    // working
    this.edgePts = []; // {x,y,nx,ny,tx,ty}
    this._rngSeed = 1337;
    this._bg = hexToRgb(CONFIG.BG_COLOR);
    this._frame = 0;

    // joystick state
    this._jx = 0;      // -1..1 (left..right)
    this._jy = 0;      // -1..1 (up..down)
    this._jmag = 0;    // 0..1
    this._jdir = 'center';
    this._jactive = false;

    // derived (updated every frame)
    this._decayEvery = DEFAULT_STACKY_DECAY_EVERY;
    this._decayAlpha = DEFAULT_TRAIL_FADE_ALPHA;
    this._strokesNow = DESK_STROKES_BASE;
    this._noiseNow   = NOISE_BASE;
    this._jitterNow  = JITTER_BASE;
    this._chainSegs  = 1;          // segments per stroke (right > 0 increases)
    this._lenScale   = 1.0;        // length multiplier (right > 0 increases)
  }

  // app.js will call this each frame with joystick state
  onJoystick({ x = 0, y = 0, mag = 0, dir = 'center', active = false } = {}) {
    this._jx = Math.max(-1, Math.min(1, x));
    this._jy = Math.max(-1, Math.min(1, y));
    this._jmag = Math.max(0, Math.min(1, mag));
    this._jdir = dir || 'center';
    this._jactive = !!active || this._jmag > 0.1;
  }

  preload(p) {}

  setup(p) {
    const isMobile = p.windowWidth <= 800;
    this.video = new VideoPlaylist({ isMobile });
    this.video.init(p.width, p.height);

    this.trails = p.createGraphics(p.width, p.height);
    this.trails.clear();

    const canvas = p._renderer?.elt || p.canvas;
    const toCanvasXY = (clientX, clientY) => {
      const r = canvas.getBoundingClientRect();
      const sx = p.width / r.width, sy = p.height / r.height;
      return { x: (clientX - r.left) * sx, y: (clientY - r.top) * sy };
    };
    const flare = (cx, cy) => {
      const { x, y } = toCanvasXY(cx, cy);
      this._flareX = x; this._flareY = y;
      this._flareUntil = p.millis() + this.FLARE_MS;
    };
    canvas.addEventListener('pointerdown', e => flare(e.clientX, e.clientY), { passive: true });
    canvas.addEventListener('touchstart',  e => { const t = e.touches[0]; if (t) flare(t.clientX, t.clientY); }, { passive: true });
  }

  dispose() { this.video?.dispose?.(); }

  resize(p) {
    this.video?.resize(p.width, p.height);
    this.trails = p.createGraphics(p.width, p.height);
    this.trails.clear();
  }

  // --- edges ---
  _collectEdgePoints(p) {
    const md = this.maskData;
    if (!md) { this.edgePts.length = 0; return; }

    const step = this.SAMPLE_STEP;
    const pts = [];
    for (let y = step; y < p.height - step; y += step) {
      for (let x = step; x < p.width - step; x += step) {
        const inside = isInside(md, p.width, p.height, x, y);
        const iL = isInside(md, p.width, p.height, x - step, y);
        const iR = isInside(md, p.width, p.height, x + step, y);
        const iU = isInside(md, p.width, p.height, x, y - step);
        const iD = isInside(md, p.width, p.height, x, y + step);
        if ((inside !== iL) || (inside !== iR) || (inside !== iU) || (inside !== iD)) {
          const bL = brightnessAt(md, p.width, p.height, x - step, y);
          const bR = brightnessAt(md, p.width, p.height, x + step, y);
          const bU = brightnessAt(md, p.width, p.height, x, y - step);
          const bD = brightnessAt(md, p.width, p.height, x, y + step);
          let nx = - (bR - bL), ny = - (bD - bU);
          const nm = Math.hypot(nx, ny) || 1;
          nx /= nm; ny /= nm;
          const tx = -ny, ty = nx;
          pts.push({ x, y, nx, ny, tx, ty });
        }
      }
    }
    if (pts.length > this.EDGE_POINTS_MAX) {
      // reservoir sample
      const out = [];
      const n = this.EDGE_POINTS_MAX;
      for (let i = 0; i < pts.length; i++) {
        if (i < n) out[i] = pts[i];
        else {
          const j = Math.floor(this._rand() * (i + 1));
          if (j < n) out[j] = pts[i];
        }
      }
      this.edgePts = out;
    } else {
      this.edgePts = pts;
    }
  }

  _rand() { // xorshift
    let x = this._rngSeed |= 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._rngSeed = x;
    return ((x >>> 0) / 4294967296);
  }

  update(p, dtMs) {
    p.background(CONFIG.BG_COLOR);
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;
    this._collectEdgePoints(p);

    // === derive dynamics from joystick each frame ===
    const isMobile = p.windowWidth <= 800;

    const ud = Math.abs(this._jy);  // linger factor 0..1
    const lrSigned = this._jx;      // -1..1
    const lrAbs = Math.abs(lrSigned);
    const rightAmt = Math.max(0, lrSigned); // 0..1
    const leftAmt  = Math.max(0, -lrSigned);

    // LINGER: lower alpha & less frequent decay as stick goes farther up/down
    this._decayEvery = Math.round(
      DECAY_EVERY_MIN + (DECAY_EVERY_MAX - DECAY_EVERY_MIN) * ud
    );
    this._decayAlpha = Math.round(
      TRAIL_ALPHA_MAX - (TRAIL_ALPHA_MAX - TRAIL_ALPHA_MIN) * ud
    );

    // BASE strokes by LR magnitude (both sides)
    const baseMin = isMobile ? MOB_STROKES_BASE : DESK_STROKES_BASE;
    const baseMax = isMobile ? MOB_STROKES_MAX  : DESK_STROKES_MAX;
    const strokesRaw = Math.round(baseMin + (baseMax - baseMin) * Math.pow(lrAbs, 0.9));

    // LEFT (<0): chaos
    this._noiseNow  = NOISE_BASE  + (NOISE_MAX  - NOISE_BASE)  * Math.pow(leftAmt, 0.9);
    this._jitterNow = JITTER_BASE + (JITTER_MAX - JITTER_BASE) * Math.pow(leftAmt, 0.9);

    // RIGHT (>0): chains (segments & length scale)
    this._chainSegs = 1 + Math.round(CHAINS_MAX_SEGMENTS * Math.pow(rightAmt, 0.95));
    this._lenScale  = 1 + (LEN_BOOST_MAX - 1) * Math.pow(rightAmt, 0.95);

    // === Auto-throttle spawn when chains get heavier ===
    // Combine two heaviness signals:
    //   • length factor (0..1 based on lenScale)
    //   • segment factor (0..1 based on number of segments)
    const lenHeaviness = (this._lenScale - 1) / (LEN_BOOST_MAX - 1); // 0..1
    const segHeaviness = (this._chainSegs - 1) / CHAINS_MAX_SEGMENTS; // 0..1
    // Overall heaviness from right deflection:
    const chainHeaviness = rightAmt * (0.55 * lenHeaviness + 0.45 * segHeaviness); // 0..1

    // Max reduction differs for mobile/desktop
    const maxReduce = isMobile ? RIGHT_STROKE_REDUCTION_MAX_MOB : RIGHT_STROKE_REDUCTION_MAX_DESK;
    const reduction = Math.min(1, Math.max(0, chainHeaviness)) * maxReduce; // 0..maxReduce

    // Final stroke budget this frame
    const strokesBudget = Math.max(
      Math.floor(strokesRaw * (1 - reduction)),
      Math.floor(baseMin * 0.5) // always keep some motion
    );
    this._strokesNow = strokesBudget;

    // --- stacky decay: only fade every _decayEvery frames
    if (this._decayEvery > 0 && (this._frame % this._decayEvery) === 0) {
      this.trails.push();
      this.trails.noStroke();
      if (FADE_TO_BG) {
        this.trails.fill(this._bg.r, this._bg.g, this._bg.b, this._decayAlpha);
      } else {
        this.trails.fill(0, 0, 0, this._decayAlpha);
      }
      this.trails.rect(0, 0, this.trails.width, this.trails.height);
      this.trails.pop();
    }

    // optional soft bloom pulse (gentle)
    if (BLUR_EVERY > 0 && (this._frame % BLUR_EVERY) === 0) {
      try { this.trails.filter(p.BLUR, BLUR_AMT); } catch (_) {}
    }

    // draw NEW curves to the trails (previous curves remain and fade in place)
    const now = p.millis();
    const flareActive = now < this._flareUntil;
    const wBase = flareActive ? this.FLARE_WEIGHT : this.BASE_WEIGHT;
    const aBase = flareActive ? this.FLARE_ALPHA  : this.BASE_ALPHA;

    this.trails.push();
    if (MONOCHROME) this.trails.colorMode(p.RGB, 255, 255, 255, 255);
    else            this.trails.colorMode(p.HSL, 360, 100, 100, 255);
    this.trails.blendMode(p.ADD);
    this.trails.noFill();

    const extra = flareActive ? 24 : 0;
    const Ncap = Math.max(0, this.edgePts.length - 4);
    const N = Math.min(this._strokesNow + extra, Ncap);

    for (let i = 0; i < N; i++) {
      // pick a starting edge point
      const k0 = Math.floor(this._rand() * this.edgePts.length);
      let pA = this.edgePts[k0];
      if (!pA) continue;

      // choose direction along the tangent
      let tdir = (this._rand() < 0.5 ? 1 : -1);

      // segment base length with right-side scale
      const baseLen = this.CURVE_LEN_MIN + this._rand() * (this.CURVE_LEN_MAX - this.CURVE_LEN_MIN);
      const segLen = baseLen * this._lenScale;

      // how many chained segments
      const segments = this._chainSegs;

      // Chaos from LEFT side
      const jn = this._noiseNow;       // curve noise factor
      const jx = this._jitterNow;      // extra random pixel jitter

      // choose color once per chain (keeps chain coherent)
      if (MONOCHROME) {
        this.trails.stroke(255, aBase);
      } else {
        const hue = 210 + Math.floor((this._rand() - 0.5) * 30);
        const sat = 30 + Math.floor(this._rand() * 20);
        const lig = 70 + Math.floor(this._rand() * 20);
        this.trails.stroke(hue, sat, lig, aBase);
      }

      let weight = wBase * (0.9 + 0.2 * this._rand());
      if (flareActive) {
        const mx0 = pA.x, my0 = pA.y;
        const d0 = Math.hypot(mx0 - this._flareX, my0 - this._flareY);
        if (d0 < this.FLARE_RADIUS) {
          const kBoost = 1 - (d0 / this.FLARE_RADIUS);
          weight *= (1.0 + 1.6 * kBoost);
        }
      }
      this.trails.strokeWeight(weight);

      // draw the chain
      for (let s = 0; s < segments; s++) {
        // pick three subsequent edge points roughly along the current tangent direction
        const p1 = this._findNearestAlong(p, pA.x + pA.tx * segLen * 0.33 * tdir, pA.y + pA.ty * segLen * 0.33 * tdir, segLen * 0.5);
        const p2 = this._findNearestAlong(p, pA.x + pA.tx * segLen * 0.66 * tdir, pA.y + pA.ty * segLen * 0.66 * tdir, segLen * 0.5);
        const p3 = this._findNearestAlong(p, pA.x + pA.tx * segLen * 1.00 * tdir, pA.y + pA.ty * segLen * 1.00 * tdir, segLen * 0.6);
        if (!p1 || !p2 || !p3) break;

        // add chaos from left-side deflection
        const c1x = p1.x + p1.tx * segLen * (jn * (this._rand() - 0.5)) + (this._rand() - 0.5) * jx;
        const c1y = p1.y + p1.ty * segLen * (jn * (this._rand() - 0.5)) + (this._rand() - 0.5) * jx;

        const c2x = p2.x + p2.tx * segLen * (jn * (this._rand() - 0.5)) + (this._rand() - 0.5) * jx;
        const c2y = p2.y + p2.ty * segLen * (jn * (this._rand() - 0.5)) + (this._rand() - 0.5) * jx;

        // draw segment from current anchor pA to p3
        this.trails.bezier(pA.x, pA.y, c1x, c1y, c2x, c2y, p3.x, p3.y);

        // next segment starts at the end of this one
        pA = p3;

        // occasionally flip direction a bit (keeps chains organic)
        if (this._rand() < 0.18) tdir *= -1;
      }
    }
    this.trails.pop();

    this._frame++;
  }

  _findNearestAlong(p, qx, qy, radius) {
    const r2 = radius * radius;
    let best = null, bestD2 = Infinity;
    const tries = 28;
    for (let t = 0; t < tries; t++) {
      const idx = Math.floor(this._rand() * this.edgePts.length);
      const e = this.edgePts[idx];
      const dx = e.x - qx, dy = e.y - qy;
      const d2 = dx*dx + dy*dy;
      if (d2 < r2 && d2 < bestD2) { best = e; bestD2 = d2; }
    }
    return best;
  }

  draw(p) {
    // draw the accumulated trail buffer; old strokes linger and fade according to joystick
    p.image(this.trails, 0, 0);
  }
}
