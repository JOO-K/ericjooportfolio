// videobezier.js — Glowing Bezier outline of the video silhouette (stacky fade).
// Click = glow burst.
//
// LINGER + JOYSTICK:
//  • Up/Down   -> linger amount (slower/faster fade of the accumulated trails)
//  • Left (<0) -> more chaos: stronger curve noise/jitter
//  • Right(>0) -> longer chains: more segments per stroke + longer segment length
//                 AND dynamically *reduce* stroke spawn to protect performance.
//
// Old strokes linger and fade based on joystick.
//
// AUDIO-REACTIVE (amped):
//  • BG color pulses harder with energy (mix toward cool blue).
//  • Strokes: hue sweeps BLUE→ORANGE by "warmth" (bass+kick vs treble), with big kick flashes.
//  • Stroke weight/alpha and stroke count scale aggressively with energy.
//  • Snare/hat add micro jitter sparkle.

import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';
import { hexToRgb } from './utils.js';

const FADE_TO_BG = true;
const MONOCHROME = false;

// Trails
const DEFAULT_STACKY_DECAY_EVERY = 3;
const DEFAULT_TRAIL_FADE_ALPHA   = 10;
const BLUR_EVERY = 5;
const BLUR_AMT   = 0.8;

// Density baselines (stronger initial effect)
const DESK_STROKES_BASE = 90;
const DESK_STROKES_MAX  = 200;
const MOB_STROKES_BASE  = 60;
const MOB_STROKES_MAX   = 130;

// Joystick chaos/chain (stronger joystick response)
const NOISE_BASE = 0.25, NOISE_MAX = 0.75;
const JITTER_BASE = 0.0, JITTER_MAX = 40.0;
const CHAINS_MAX_SEGMENTS = 7;
const LEN_BOOST_MAX       = 3.5;
const RIGHT_STROKE_REDUCTION_MAX_DESK = 0.55;
const RIGHT_STROKE_REDUCTION_MAX_MOB  = 0.65;

// Linger ranges
const DECAY_EVERY_MIN = 2, DECAY_EVERY_MAX = 8;
const TRAIL_ALPHA_MIN = 3, TRAIL_ALPHA_MAX = 18;

// Utils
const clamp01 = v => Math.max(0, Math.min(1, v));
const lerp = (a,b,t)=>a+(b-a)*t;
function rgbLerp(a, b, t){
  return { r: Math.round(lerp(a.r,b.r,t)), g: Math.round(lerp(a.g,b.g,t)), b: Math.round(lerp(a.b,b.b,t)) };
}
function brightnessAt(maskData, w, h, x, y) {
  if (!maskData) return 255;
  const xi = x | 0, yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 255;
  const i = (yi * w + xi) << 2;
  const a = maskData[i + 3]; if (a < 8) return 255;
  const r = maskData[i], g = maskData[i + 1], b = maskData[i + 2];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const isInside = (md,w,h,x,y)=> brightnessAt(md,w,h,x,y) < CONFIG.VIDEO.SIL_BRIGHTNESS_THRESHOLD;

export default class VideoBezierOutlineEffect {
  constructor() {
    this.name = 'Video Bezier Silhouette (Stacky + Linger + Chains + LOUD audio color/weight/bg pulse)';

    // video/mask
    this.video = null;
    this.maskData = null;

    // edge sampling
    this.SAMPLE_STEP = 6;
    this.EDGE_POINTS_MAX = 2400;

    // stroke gen baseline (stronger)
    this.STROKES_PER_FRAME = 120;
    this.CURVE_LEN_MIN = 40;
    this.CURVE_LEN_MAX = 150;

    // trails (more visible)
    this.trails = null;
    this.TRAIL_FADE = DEFAULT_TRAIL_FADE_ALPHA;
    this.BASE_WEIGHT = 1.5;
    this.BASE_ALPHA  = 120;

    // click glow
    this._flareUntil = 0;
    this._flareX = 0; this._flareY = 0;
    this.FLARE_MS     = 900;
    this.FLARE_WEIGHT = 3.2;
    this.FLARE_ALPHA  = 255;
    this.FLARE_RADIUS = 260;

    // working
    this.edgePts = [];
    this._rngSeed = 1337;
    this._bgRGB = null;
    this._frame = 0;

    // joystick
    this._jx = 0; this._jy = 0; this._jmag = 0; this._jdir = 'center'; this._jactive = false;

    // derived
    this._decayEvery = DEFAULT_STACKY_DECAY_EVERY;
    this._decayAlpha = DEFAULT_TRAIL_FADE_ALPHA;
    this._strokesNow = DESK_STROKES_BASE;
    this._noiseNow   = NOISE_BASE;
    this._jitterNow  = JITTER_BASE;
    this._chainSegs  = 1;
    this._lenScale   = 1.0;

    // AUDIO envelopes / flash
    this._kEnv = 0; this._sEnv = 0; this._hEnv = 0; this._prevK = 0;
    this.K_ATTACK = 1.0; this.K_DECAY = 0.86;
    this.S_ATTACK = 0.85; this.S_DECAY = 0.90;
    this.H_ATTACK = 0.80; this.H_DECAY = 0.92;

    // kick flash (multiplier that blooms & decays quickly)
    this._flash = 0; this.FLASH_DECAY = 0.86;

    // BG pulse target (cool blue)
    this._bgPulseRGB = { r: 150, g: 190, b: 255 };

    // Color span (BLUE→ORANGE)
    this.HUE_BLUE   = 210; // blue/cyan
    this.HUE_ORANGE = 30;  // orange/red
  }

  onJoystick({ x = 0, y = 0, mag = 0, dir = 'center', active = false } = {}) {
    this._jx = Math.max(-1, Math.min(1, x));
    this._jy = Math.max(-1, Math.min(1, y));
    this._jmag = clamp01(mag);
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

    this._bgRGB = hexToRgb(CONFIG.BG_COLOR);

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

  _audio() {
    const b = window.__AUDIO_BUS || {};
    const c = v=>Math.max(0, Math.min(1, v ?? 0));
    return {
      playing: !!b.playing,
      rms: c(b.rms),
      bass: c(b.bands?.bass),
      lowMid: c(b.bands?.lowMid),
      mid: c(b.bands?.mid),
      highMid: c(b.bands?.highMid),
      treble: c(b.bands?.treble),
      k: c(b.kick),
      s: c(b.snare),
      h: c(b.hat),
    };
  }

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
    const A = this._audio();

    // Kick edge → flash & strong envelope
    const EDGE = 0.55;
    if (A.k > EDGE && this._prevK <= EDGE) { this._kEnv = 1.0; this._flash = 1.0; }
    this._prevK = A.k;
    // decay/attack
    this._kEnv = Math.max(this._kEnv * this.K_DECAY, A.k * this.K_ATTACK);
    this._sEnv = Math.max(this._sEnv * this.S_DECAY, A.s * this.S_ATTACK);
    this._hEnv = Math.max(this._hEnv * this.H_DECAY, A.h * this.H_ATTACK);
    this._flash *= this.FLASH_DECAY;

    // BG pulse harder: mix base BG toward blue by energy
    const energy = clamp01(0.55*A.rms + 0.75*A.bass + 0.65*this._kEnv);
    const bgMix = 0.30 * Math.pow(energy, 0.8) + 0.12 * this._flash; // more punch on kick
    const bgNow = rgbLerp(this._bgRGB, this._bgPulseRGB, Math.min(0.6, bgMix));
    p.background(`rgb(${bgNow.r},${bgNow.g},${bgNow.b})`);

    // mask & edges
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;
    this._collectEdgePoints(p);

    // Joystick → linger, chaos, chains
    const isMobile = p.windowWidth <= 800;
    const ud = Math.abs(this._jy);
    const lrSigned = this._jx;
    const lrAbs = Math.abs(lrSigned);
    const rightAmt = Math.max(0, lrSigned);
    const leftAmt  = Math.max(0, -lrSigned);

    this._decayEvery = Math.round(lerp(DECAY_EVERY_MIN, DECAY_EVERY_MAX, ud));
    this._decayAlpha = Math.round(lerp(TRAIL_ALPHA_MAX, TRAIL_ALPHA_MIN, ud));

    const baseMin = isMobile ? MOB_STROKES_BASE : DESK_STROKES_BASE;
    const baseMax = isMobile ? MOB_STROKES_MAX  : DESK_STROKES_MAX;
    // BIG musical boost to stroke budget
    const energyForCount = clamp01(0.65*A.rms + 0.75*this._kEnv + 0.55*A.treble + 0.45*A.bass);
    let strokesRaw = Math.round(lerp(baseMin, baseMax, Math.pow(lrAbs, 0.9)));
    strokesRaw = Math.round(strokesRaw * (1.20 + 1.60 * energyForCount)); // 1.2x..2.8x

    this._noiseNow  = lerp(NOISE_BASE,  NOISE_MAX,  Math.pow(leftAmt,  0.9));
    this._jitterNow = lerp(JITTER_BASE, JITTER_MAX, Math.pow(leftAmt,  0.9));

    this._chainSegs = 1 + Math.round(CHAINS_MAX_SEGMENTS * Math.pow(rightAmt, 0.95));
    this._lenScale  = 1 + (LEN_BOOST_MAX - 1) * Math.pow(rightAmt, 0.95);

    const lenHeaviness = (this._lenScale - 1) / (LEN_BOOST_MAX - 1);
    const segHeaviness = (this._chainSegs - 1) / CHAINS_MAX_SEGMENTS;
    const chainHeaviness = rightAmt * (0.55*lenHeaviness + 0.45*segHeaviness);
    const maxReduce = isMobile ? RIGHT_STROKE_REDUCTION_MAX_MOB : RIGHT_STROKE_REDUCTION_MAX_DESK;
    const reduction = clamp01(chainHeaviness) * maxReduce;

    this._strokesNow = Math.max(
      Math.floor(strokesRaw * (1 - reduction)),
      Math.floor(baseMin * 0.6)
    );

    // stacky decay
    if (this._decayEvery > 0 && (this._frame % this._decayEvery) === 0) {
      this.trails.push();
      this.trails.noStroke();
      if (FADE_TO_BG) this.trails.fill(this._bgRGB.r, this._bgRGB.g, this._bgRGB.b, this._decayAlpha);
      else            this.trails.fill(0, 0, 0, this._decayAlpha);
      this.trails.rect(0, 0, this.trails.width, this.trails.height);
      this.trails.pop();
    }

    if (BLUR_EVERY > 0 && (this._frame % BLUR_EVERY) === 0) {
      try { this.trails.filter(p.BLUR, BLUR_AMT); } catch (_) {}
    }

    // stroke base from music
    const weightMusic = 1.0 + 2.0*this._kEnv + 1.2*A.bass + 0.7*A.rms;   // punchy
    const alphaMusic  = 0.65 + 0.55*clamp01(A.rms + 0.9*this._kEnv + 0.6*A.treble);
    const wBase = (this._isFlared(p) ? this.FLARE_WEIGHT : this.BASE_WEIGHT) * (weightMusic + 0.6*this._flash);
    const aBase = Math.min(255, Math.round((this._isFlared(p) ? this.FLARE_ALPHA : this.BASE_ALPHA) * alphaMusic));

    this.trails.push();
    if (MONOCHROME) this.trails.colorMode(p.RGB, 255, 255, 255, 255);
    else            this.trails.colorMode(p.HSL, 360, 100, 100, 255);
    this.trails.blendMode(p.ADD);
    this.trails.noFill();

    const extra = this._isFlared(p) ? 30 : 0;
    const Ncap = Math.max(0, this.edgePts.length - 4);
    const N = Math.min(this._strokesNow + extra, Ncap);

    // BLUE→ORANGE mapping: treble pushes toward blue, bass+kick pushes toward orange
    const warmth = clamp01(0.65*A.bass + 0.90*this._kEnv + 0.25*A.rms - 0.55*A.treble + 0.20*this._flash);
    const hueBase = lerp(this.HUE_BLUE, this.HUE_ORANGE, warmth);
    const satBoost = 24 + 40 * clamp01(A.rms + 0.5*this._kEnv + 0.4*A.treble);
    const ligBase  = 58 + 18 * (1.0 - A.bass) + 10*this._flash;

    for (let i = 0; i < N; i++) {
      // pick start
      const k0 = Math.floor(this._rand() * this.edgePts.length);
      let pA = this.edgePts[k0];
      if (!pA) continue;

      let tdir = (this._rand() < 0.5 ? 1 : -1);

      const baseLen = this.CURVE_LEN_MIN + this._rand() * (this.CURVE_LEN_MAX - this.CURVE_LEN_MIN);
      const segLen = baseLen * this._lenScale;
      const segments = this._chainSegs;

      const jn = this._noiseNow;
      const jx = this._jitterNow;

      if (MONOCHROME) {
        this.trails.stroke(255, aBase);
      } else {
        // small per-chain hue jitter around the music-chosen hue
        const hue = (hueBase + (this._rand() - 0.5)*28 + 360) % 360;
        const sat = Math.min(100, Math.max(35, satBoost));
        const lig = Math.min(92, Math.max(50, ligBase + (this._rand()-0.5)*8));
        this.trails.stroke(hue, sat, lig, aBase);
      }

      // weight with proximity boost to flare + extra from flash
      let weight = wBase * (0.95 + 0.25 * this._rand());
      this.trails.strokeWeight(weight);

      for (let s = 0; s < segments; s++) {
        const p1 = this._findNearestAlong(p, pA.x + pA.tx * segLen * 0.33 * tdir, pA.y + pA.ty * segLen * 0.33 * tdir, segLen * 0.5);
        const p2 = this._findNearestAlong(p, pA.x + pA.tx * segLen * 0.66 * tdir, pA.y + pA.ty * segLen * 0.66 * tdir, segLen * 0.5);
        const p3 = this._findNearestAlong(p, pA.x + pA.tx * segLen * 1.00 * tdir, pA.y + pA.ty * segLen * 1.00 * tdir, segLen * 0.6);
        if (!p1 || !p2 || !p3) break;

        // micro sparkle from snare/hat
        const sparkle = (0.8*this._sEnv + 1.0*this._hEnv) * 3.2;
        const jitterExtra = (this._rand() - 0.5) * (jx + sparkle);

        const c1x = p1.x + p1.tx * segLen * (jn * (this._rand() - 0.5)) + jitterExtra;
        const c1y = p1.y + p1.ty * segLen * (jn * (this._rand() - 0.5)) + jitterExtra;

        const c2x = p2.x + p2.tx * segLen * (jn * (this._rand() - 0.5)) + jitterExtra;
        const c2y = p2.y + p2.ty * segLen * (jn * (this._rand() - 0.5)) + jitterExtra;

        this.trails.bezier(pA.x, pA.y, c1x, c1y, c2x, c2y, p3.x, p3.y);

        pA = p3;
        if (this._rand() < 0.18) tdir *= -1;
      }

      // --- toned-down ghost stroke echo on big flashes (THINNER) ---
      if (this._flash > 0.35 && !MONOCHROME && (this._rand() < 0.35)) {
        // gentler multiplier + hard cap to keep it subtle
        const ghostW = Math.min(2.0, weight * (1.10 + 0.25 * this._flash));
        this.trails.strokeWeight(ghostW);
        this.trails.stroke((hueBase + 10) % 360, 90, 72, Math.min(255, aBase));
        const g = this.edgePts[(k0 + 7) % this.edgePts.length];
        if (g) this.trails.line(pA.x, pA.y, g.x, g.y);
      }
    }
    this.trails.pop();

    this._frame++;
  }

  _isFlared(p){ return p.millis() < this._flareUntil; }

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
    p.image(this.trails, 0, 0);
  }
}
