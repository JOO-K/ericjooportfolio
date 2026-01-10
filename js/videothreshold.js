// videothreshold.js — solid white threshold grid (raindrops + stroke length by joystick)
// + OPTIONAL (only while joystick active): shape morph (line→cross→diamond→dot) + light color bloom
//
// Background: Audio-reactive Perlin terrain bands + Convex Hull (c2.js) drawn FIRST behind the grid.
//   - Offscreen c2.Renderer; composited into the p5 canvas (no visible extra canvas).
//   - BG fades in only while music is playing, based on window.__AUDIO_BUS.
//   - Grid is NOT audio-reactive.

import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';

/* ---------- tiny helpers ---------- */
function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/* ---------- Inline Kaleidoscope Perlin BG (heavily randomized per-load) ---------- */
class InlineVoronoiBG {
  constructor() {
    this.hasC2 = !!window.c2;
    this.canvas = null;
    this.renderer = null;
    this.perlin = null;

    // audio fade
    this.alpha = 0;
    this.fadeSlew = 0.16;

    // time
    this._t = 0;

    // defaults (will be overridden in _initRandom)
    this.petals    = 8;
    this.ringsBase = 13;
    this.samples   = 240;
    this.innerFrac = 0.06;
    this.outerFrac = 0.95;

    // stroke look (will randomize)
    this.strokeBase = 0.65;
    this.strokeKick = 1.6;

    // per-load randomness
    this._seed = 0;
    this._rndReady = false;

    // fold + hue + perlin domain/random
    this._foldType = 'mirror';   // 'mirror' | 'wrap' | 'star'
    this._baseRot  = 0;
    this._nxOff = 0; this._nyOff = 0;
    this._freqBias = 1.0;

    this._palette = 'cool';      // 'cool' | 'warm' | 'mono'
    this._hueBias = 0;           // ±40°
    this._satBias = 0;           // -20..+20
    this._lightBias = 0;         // -8..+8

    this._dashPolicy = 'hats';   // 'none' | 'hats' | 'sporadic'

    // ring personality source: shuffled start + per-ring noise
    this._ringModeStart = 0;
    this._ringNoise = 0.0;

    // drums
    this._prevK = 0; this._prevS = 0; this._prevH = 0;
    this.kickImpulse  = 0;
    this.snareImpulse = 0;
    this.hatImpulse   = 0;
  }

  /* ---------- seed helpers ---------- */
  _seedFromEnv() {
    if (typeof window !== 'undefined' && window.KALEIDO_SEED != null) {
      return Number(window.KALEIDO_SEED) | 0;
    }
    if (window.crypto?.getRandomValues) {
      const a = new Uint32Array(1);
      window.crypto.getRandomValues(a);
      return a[0] | 0;
    }
    // fallback: time + UA hash + Math.random
    let s = (Date.now() ^ (performance?.now() || 0)) | 0;
    const ua = (navigator?.userAgent || '') + Math.random();
    for (let i = 0; i < ua.length; i++) s = ((s << 5) - s + ua.charCodeAt(i)) | 0;
    return s | 0;
  }
  _rand(){ let x = this._seed |= 0; x ^= x<<13; x ^= x>>>17; x ^= x<<5; this._seed = x; return ((x>>>0)/4294967296); }
  _r(a,b){ return a + (b-a)*this._rand(); }
  _pick(arr){ return arr[Math.floor(this._rand()*arr.length)] }
  _pickW(items, weights){ let t=weights.reduce((a,b)=>a+b,0), r=this._rand()*t; for(let i=0;i<items.length;i++){ r-=weights[i]; if(r<=0) return items[i]; } return items[items.length-1]; }

  _initRandom() {
    if (this._rndReady) return;
    this._seed = this._seedFromEnv();

    // petals: 5–14 (weight to 8–12 for pleasing symmetry)
    this.petals = this._pickW(
      [5,6,7,8,9,10,11,12,13,14],
      [1,2,1,4,3,4,3,4,1,1]
    );

    // rings + density + extents (REDUCED for performance)
    this.ringsBase = Math.round(this._r(6, 12));
    this.samples   = Math.round(this._r(100, 200));
    this.innerFrac = this._r(0.03, 0.14);
    this.outerFrac = this._r(0.86, 0.99);

    // perlin detail/seed + domain offsets + frequency bias (REDUCED octaves for performance)
    const octaves = Math.floor(this._r(2, 3));
    const gain    = this._r(0.38, 0.65);
    this._perlinDetail = { octaves, gain };
    this._perlinSeed   = (this._r(0, 1e9) | 0);
    this._nxOff  = this._r(-20, 20);
    this._nyOff  = this._r(-20, 20);
    this._freqBias = this._r(0.65, 1.35);

    // base rotation
    this._baseRot = this._r(0, Math.PI*2);

    // folding style
    this._foldType = this._pickW(['mirror','wrap','star'], [5,3,2]);

    // stroke behavior
    this.strokeBase = this._r(0.40, 0.90);
    this.strokeKick = this._r(1.2, 2.2);

    // dash policy
    this._dashPolicy = this._pickW(['none','hats','sporadic'], [2,5,3]);

    // hue palette
    this._palette = this._pickW(['cool','warm','mono'], [5,3,2]);
    this._hueBias   = this._r(-40, 40);
    this._satBias   = this._r(-20, 20);
    this._lightBias = this._r(-8, 8);

    // ring personalities: randomized start & noise driver
    this._ringModeStart = Math.floor(this._r(0, 3)); // 0..2
    this._ringNoise = this._r(0.08, 0.28);

    this._rndReady = true;
  }

  _bus() {
    const b = window.__AUDIO_BUS || {};
    const c = v=>Math.max(0, Math.min(1, v ?? 0));
    return {
      rms:c(b.rms), bass:c(b.bands?.bass), mid:c(b.bands?.mid), treb:c(b.bands?.treble),
      k:c(b.kick), s:c(b.snare), h:c(b.hat),
    };
  }

  _ensureInit(p) {
    if (!this.hasC2) return false;
    const c2 = window.c2;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width  = Math.max(1, p.width|0);
      this.canvas.height = Math.max(1, p.height|0);
    }
    if (!this.renderer) {
      this.renderer = new c2.Renderer(this.canvas);
      this.renderer.background(false);
      this.perlin = new c2.Perlin();
      this._initRandom();
      // apply randomized perlin config
      try { this.perlin.detail(this._perlinDetail.octaves, this._perlinDetail.gain); } catch {}
      try { this.perlin.seed?.(this._perlinSeed); } catch {}
    }
    return true;
  }

  setup(p){ this._ensureInit(p); }
  resize(p){
    if (!this._ensureInit(p)) return;
    this.canvas.width  = Math.max(1, p.width|0);
    this.canvas.height = Math.max(1, p.height|0);
    this.renderer.size(this.canvas.width, this.canvas.height);
    // no re-seed on resize (keeps the “session look”)
  }

  _updateDrums(bus){
    if (bus.k>0.6 && this._prevK<=0.6) this.kickImpulse=1.0;
    if (bus.s>0.55&& this._prevS<=0.55) this.snareImpulse=1.0;
    if (bus.h>0.50&& this._prevH<=0.50) this.hatImpulse=1.0;
    this.kickImpulse*=0.90; this.snareImpulse*=0.90; this.hatImpulse*=0.92;
    this._prevK=bus.k; this._prevS=bus.s; this._prevH=bus.h;
  }

  // folding variants
  _foldAngle(ang, sector){
    if (this._foldType === 'mirror') {
      const aIn = ang % sector;
      const aFold = (aIn <= sector*0.5) ? aIn : (sector - aIn);
      return Math.floor(ang/sector)*sector + aFold;
    } else if (this._foldType === 'wrap') {
      // simple wrap (no mirror) for a star-wheel vibe
      const aIn = ang % sector;
      return Math.floor(ang/sector)*sector + aIn;
    } else { // 'star' – mirror but also alternate a slight offset every other sector
      const idx = Math.floor(ang/sector);
      const aIn = ang % sector;
      const aFold = (aIn <= sector*0.5) ? aIn : (sector - aIn);
      const offset = (idx % 2 === 0) ? 0.0 : sector*0.08;
      return idx*sector + Math.max(0, Math.min(sector*0.5, aFold + offset));
    }
  }

  update(p, dt){
    if (!this._ensureInit(p)) return;

    const bus = this._bus();
    const dtC = Math.max(0.016, dt || 0.016);

    // audio fade gate
    const alive = bus.rms > 0.02;
    this.alpha += ((alive?1:0) - this.alpha) * this.fadeSlew;
    if (this.alpha < 0.01) return;

    this._updateDrums(bus);

    // time speed
    const baseSpeed = 0.10;
    const speed = baseSpeed * (1.0 + 1.4*bus.bass + 0.35*bus.treb);
    this._t += dtC * speed * 60;

    // canvas metrics
    const W = this.canvas.width, H = this.canvas.height;
    const cx = W*0.5, cy = H*0.5;
    const Rmin = Math.min(W,H)*this.innerFrac;
    const Rmax = Math.min(W,H)*this.outerFrac;

    // dynamic ring count (REDUCED for performance)
    const rings = Math.max(6, Math.round(this.ringsBase + 4*(bus.rms + 0.35*bus.mid)));

    // amplitude budget
    const ampBase  = 0.05*Rmax;
    const ampAudio = (0.28*bus.bass + 0.14*bus.mid + 0.18*this.kickImpulse)*Rmax;

    // wobble
    const wobble = (this.perlin.noise(this._t*0.03, 0.17)-0.5) * (0.06 + 0.20*this.snareImpulse);

    this.renderer.clear();
    this.renderer.fill(false);

    const TWO_PI = Math.PI*2;
    const sector = TWO_PI / this.petals;

    for (let i=0;i<rings;i++){
      const tRing = i / Math.max(1, rings-1);
      const rBase = c2.map(i,0,rings-1,Rmin,Rmax);

      // per-ring mode chosen from shuffled start + noise
      const mNoise = this.perlin.noise(i*this._ringNoise + 100.123, this._t*0.01);
      const mode = (this._ringModeStart + Math.round(mNoise*4)) % 3; // 0..2 but biased by noise

      // per-ring params (with per-load freq bias)
      let perlinGain, perlinFreq, shimmerGain, kickPulseGain, kickPulseFreq, hueShift, dashOnHat;
      if (mode === 0) {
        perlinGain = 0.45;  perlinFreq = 1.15 * this._freqBias;
        shimmerGain = 1.0 + 0.8*(bus.h + 0.35*this.hatImpulse);
        kickPulseGain = 0.12; kickPulseFreq = 0.9;
        hueShift = -4; dashOnHat = false;
      } else if (mode === 1) {
        perlinGain = 1.25;  perlinFreq = 0.85 * this._freqBias;
        shimmerGain = 0.45 + 0.35*(bus.h + 0.25*this.snareImpulse);
        kickPulseGain = 0.18; kickPulseFreq = 0.7;
        hueShift = 0;   dashOnHat = (this._dashPolicy === 'sporadic');
      } else {
        perlinGain = 0.85;  perlinFreq = 1.00 * this._freqBias;
        shimmerGain = 0.60 + 0.5*(bus.h + 0.25*this.snareImpulse);
        kickPulseGain = 0.35; kickPulseFreq = 1.20;
        hueShift = +6; dashOnHat = (this._dashPolicy !== 'none');
      }

      const pop = (0.35 + 0.65*tRing) * this.kickImpulse;
      const lineW = Math.min(this.strokeKick, this.strokeBase + pop);
      this.renderer.lineWidth(lineW);

      // palette
      let baseHue = 210; // cool anchor
      let satBase = 10;
      let lightBase = 46;
      if (this._palette === 'warm') baseHue = 28;
      if (this._palette === 'mono') { satBase = 0; }
      const hue = baseHue + this._hueBias + hueShift + 10*bus.treb;
      const sat = Math.max(0, Math.min(100, satBase + Math.round(14*(0.35+0.65*bus.treb)) + this._satBias));
      const light = Math.max(0, Math.min(100, Math.round(lightBase + (1 - tRing)*16 + this._lightBias)));
      this.renderer.stroke(window.c2.Color.hsl((hue%360+360)%360, sat, light));

      // dash
      if (this.renderer.lineDash) {
        if (dashOnHat && (bus.h + this.hatImpulse > 0.35)) {
          const dashLen = 6 + Math.round(12 * (bus.h + 0.5*this.hatImpulse));
          const gapLen  = 4 + Math.round(10 * (bus.h + 0.5*this.hatImpulse));
          this.renderer.lineDash([dashLen, gapLen]);
        } else if (this._dashPolicy === 'sporadic' && this._rand() < 0.12) {
          this.renderer.lineDash([8 + Math.floor(this._rand()*10), 6 + Math.floor(this._rand()*8)]);
        } else {
          this.renderer.lineDash([]);
        }
      }

      const amp = (ampBase + ampAudio) * Math.pow(tRing, 0.75) * perlinGain;
      const rot = this._baseRot + wobble + (mode - 1)*0.03*(0.4+0.6*bus.treb);

      this.renderer.beginPath();

      for (let j=0;j<this.samples;j++){
        const t = j/(this.samples-1);
        let ang = t*TWO_PI + rot;

        // fold
        const aOut = this._foldAngle(ang, sector);

        // perlin domain with offsets
        const nx = this._nxOff + 0.035*this._t + Math.cos(aOut)*0.35*perlinFreq + i*0.041;
        const ny = this._nyOff + 0.035*this._t + Math.sin(aOut)*0.35*perlinFreq - i*0.033;

        let r = rBase + (this.perlin.noise(nx, ny) - 0.5) * amp;

        // shimmer
        r += Math.sin(this._t*0.04*(1 + 14*(bus.h + 0.4*this.hatImpulse)) + j*0.22 + i*0.35)
           * (2 + 8*shimmerGain);

        // kick pulse
        const kp = kickPulseGain * this.kickImpulse;
        if (kp > 0.001) {
          r += Math.sin(this._t*0.10*(kickPulseFreq*(1 + 2.0*this.kickImpulse)) + t*TWO_PI*2.0) * (6 + 38*kp);
        }

        // clamp
        r = Math.max(Rmin*0.9, Math.min(Rmax, r));
        const x = cx + Math.cos(aOut)*r;
        const y = cy + Math.sin(aOut)*r;

        if (j===0 && this.renderer.moveTo) this.renderer.moveTo(x,y);
        else this.renderer.lineTo(x,y);
      }

      this.renderer.endPath(false);
    }

    // center burst
    if (this.kickImpulse > 0.28) {
      const lw = Math.min(this.strokeKick, this.strokeBase + this.kickImpulse*1.3);
      this.renderer.lineWidth(lw);
      if (this.renderer.lineDash) this.renderer.lineDash([]);
      const spokes = this.petals * 2;
      const Rmin2 = Math.min(W,H)*this.innerFrac;
      const Rmax2 = Math.min(W,H)*this.outerFrac;
      for (let s=0;s<spokes;s++){
        const a = (s/spokes)*TWO_PI + (wobble*0.6 + this._baseRot);
        const x0 = cx + Math.cos(a)*(Rmin2*0.95);
        const y0 = cy + Math.sin(a)*(Rmin2*0.95);
        const x1 = cx + Math.cos(a)*(Rmin2 + 0.18*(Rmax2 - Rmin2)*this.kickImpulse);
        const y1 = cy + Math.sin(a)*(Rmin2 + 0.18*(Rmax2 - Rmin2)*this.kickImpulse);
        this.renderer.beginPath();
        this.renderer.lineTo(x0,y0);
        this.renderer.lineTo(x1,y1);
        this.renderer.endPath(false);
      }
    }
  }

  draw(p){
    if (!this.hasC2 || !this.canvas || this.alpha < 0.01) return;
    p.push();
    try {
      p.drawingContext.save();
      p.drawingContext.globalAlpha = this.alpha * 0.9;
      p.drawingContext.drawImage(this.canvas, 0, 0, p.width, p.height);
      p.drawingContext.restore();
    } catch(_) {}
    p.pop();
  }
}



/* ========================================================================== */

export default class VideoThresholdEffect {
  constructor(opts = {}) {
    this.name = 'Video Threshold Grid (raindrops + stroke length)';

    // video sharing
    this.video = opts.playlist || null;
    this._ownsVideo = !this.video;
    this.maskData = null;

    // grid density
    this.cellDesktop = Math.max(18, CONFIG.GRID_DESKTOP);
    this.cellMobile  = Math.max(10,  CONFIG.GRID_MOBILE);
    this.PHASES      = 1;     // draw ALL cells → no flicker
    this.phaseTick   = 0;

    // threshold
    this.threshold = CONFIG.VIDEO.SIL_BRIGHTNESS_THRESHOLD;

    // look
    this.strokeMin   = 1.0;
    this.strokeMax   = 2.6;
    this.sizeMin     = 2;
    this.sizeMax     = 0.90;
    this.strokeColor = 255;   // pure white (idle)

    // hover attraction
    this.pointerX = -1;
    this.pointerY = -1;
    this.hoverRadius = 140;   // px
    this.hoverPull   = 1200;  // force

    // bullet-hole ripple timing
    this.HOLE_RADIUS_BASE = 150;
    this.GROW_TIME   = 0.10;
    this.HOLD_TIME   = 0.25;
    this.DECAY_TIME  = 0.60;

    // shove forces
    this.EDGE_BAND     = 28;
    this.EDGE_PUSH     = 9000;
    this.INSIDE_PUSH   = 14000;

    // extra instantaneous kick
    this.IMPACT_WINDOW = 0.085;
    this.IMPULSE_VEL   = 2200;

    this.MAX_RIPPLES = 18;
    this.ripples = [];           // { x, y, t0, radius }

    // springs to center
    this.springK = 40;
    this.damping = 6;

    // per-cell state
    this.cols = 0; this.rows = 0; this.cell = 24;
    this.state = null;           // Float32Array [ox,oy,vx,vy]*

    this._dt = 1/60;
    this._canvas = null;

    // joystick state
    this._jx = 0; this._jy = 0; this._jmag = 0; this._jactive = false;

    // raindrops
    this.dropRateHz   = 0;
    this.dropClockSec = 0;
    this.dropRadius   = this.HOLE_RADIUS_BASE;

    // stroke length scaling (cross arm length)
    this.strokeLenScale = 1.0;

    // shape morph (active only)
    this._shapePhase = 0;
    this._hueBase = 210; this._hueSpan = 50; this._bloom = 0.6; this._joyActiveEps = 0.12;

    // background
    this._bg = new InlineVoronoiBG();
  }

  // joystick mapping
  onJoystick({ x = 0, y = 0, mag = 0, active = false } = {}) {
    this._jx = x;
    this._jy = y;
    this._jmag = clamp01(mag || 0);
    this._jactive = !!active || this._jmag > this._joyActiveEps;

    const magY = Math.min(1, Math.max(0, Math.abs(y)));

    // Frequency — drizzle faster, heavy slower
    const MAX_HZ = 20;
    const baseHz = MAX_HZ * magY;
    this.dropRateHz = y >= 0 ? baseHz * 0.45 : baseHz * 1.20;

    // Radius — drizzle smaller min, heavy larger
    const R_SMALL = 40;
    const R_LARGE = 240;
    this.dropRadius = y >= 0
      ? lerp(this.HOLE_RADIUS_BASE, R_LARGE, magY)
      : lerp(R_SMALL, this.HOLE_RADIUS_BASE, magY);

    // Stroke length — map X into ~0.55..1.9
    const magX = Math.min(1, Math.max(0, Math.abs(x)));
    const minS = 0.55, maxS = 1.9;
    this.strokeLenScale = x >= 0 ? lerp(1.0, maxS, magX) : lerp(1.0, minS, magX);

    // Shape morph phase (0..1) only used while active
    this._shapePhase = magX;
  }

  preload(p) {}

  setup(p) {
    if (this._ownsVideo) {
      const isMobile = p.windowWidth <= 800;
      this.video = new VideoPlaylist({ isMobile });
      this.video.init(p.width, p.height);
    } else {
      this.video?.resize?.(p.width, p.height);
    }
    this._rebuildGrid(p);

    // robust: lazy init inside bg, but call once here too
    this._bg.setup(p);

    p.strokeCap(p.ROUND);
    p.strokeJoin(p.ROUND);

    // pointer
    const c = p._renderer?.elt || p.canvas;
    this._canvas = c;
    const toCanvas = (clientX, clientY) => {
      const r = c.getBoundingClientRect();
      const sx = p.width / r.width, sy = p.height / r.height;
      return { x: (clientX - r.left) * sx, y: (clientY - r.top) * sy };
    };
    const onMove = (clientX, clientY) => {
      const { x, y } = toCanvas(clientX, clientY);
      this.pointerX = x; this.pointerY = y;
    };
    const onLeave = () => { this.pointerX = this.pointerY = -1; };
    const onClick = (clientX, clientY) => {
      const { x, y } = toCanvas(clientX, clientY);
      const tSec = p.millis() * 0.001;
      this._spawnRipple(x, y, tSec, this.HOLE_RADIUS_BASE);
    };

    c.addEventListener('pointermove', e => onMove(e.clientX, e.clientY), { passive: true });
    c.addEventListener('pointerenter', e => onMove(e.clientX, e.clientY), { passive: true });
    c.addEventListener('pointerleave', onLeave, { passive: true });
    c.addEventListener('pointerdown', e => onClick(e.clientX, e.clientY), { passive: true });
    c.addEventListener('touchstart',  e => { const t = e.touches[0]; if (t) onClick(t.clientX, t.clientY); }, { passive: true });
    c.addEventListener('touchmove',   e => { const t = e.touches[0]; if (t) onMove(t.clientX, t.clientY); }, { passive: true });
    c.addEventListener('touchend', onLeave, { passive: true });
    c.addEventListener('touchcancel', onLeave, { passive: true });
  }

  dispose() { if (this._ownsVideo) this.video?.dispose?.(); }

  resize(p) {
    this.video?.resize?.(p.width, p.height);
    this._rebuildGrid(p);
    this._bg.resize(p);
  }

  _rebuildGrid(p) {
    this.cell = (p.windowWidth <= 800) ? this.cellMobile : this.cellDesktop;
    this.cols = Math.floor(p.width  / this.cell);
    this.rows = Math.floor(p.height / this.cell);
    this.state = new Float32Array(this.cols * this.rows * 4);
  }

  // mask helpers
  _brightnessAt(px, py, p) {
    const m = this.maskData;
    if (!m) return 255;
    const x = px | 0, y = py | 0;
    if (x < 0 || y < 0 || x >= p.width || y >= p.height) return 255;
    const i = (y * p.width + x) << 2;
    const a = m[i + 3]; if (a < 8) return 255;
    const r = m[i], g = m[i + 1], b = m[i + 2];
    return 0.2126*r + 0.7152*g + 0.0722*b;
  }
  _isSilhouette(px, py, p) {
    if (this.video?.isSilhouetteAt)
      return this.video.isSilhouetteAt(this.maskData, p.width, p.height, px, py);
    return this._brightnessAt(px, py, p) < this.threshold;
  }
  _smoothstep(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x*x*(3 - 2*x); }

  // ripple profile
  _rippleRadius(now, rp) {
    const age = Math.max(0, now - rp.t0);
    if (age < this.GROW_TIME) {
      const t = this._smoothstep(age / this.GROW_TIME); return rp.radius * t;
    }
    if (age < this.GROW_TIME + this.HOLD_TIME) return rp.radius;
    const d = age - (this.GROW_TIME + this.HOLD_TIME);
    if (d < this.DECAY_TIME) {
      const t = 1 - this._smoothstep(d / this.DECAY_TIME); return rp.radius * t;
    }
    return -1;
  }

  _spawnRipple(x, y, tSec, radius) {
    this.ripples.push({ x, y, t0: tSec, radius: radius ?? this.HOLE_RADIUS_BASE });
    if (this.ripples.length > this.MAX_RIPPLES) this.ripples.shift();
  }

  update(p, dtMs) {
    this._dt = Math.max(0.001, Math.min(0.033, (dtMs || 16.7) / 1000));
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;

    p.background(CONFIG.BG_COLOR);

    // update bg first (so it draws behind)
    this._bg.update(p, this._dt);

    // prune finished ripples
    const now = p.millis() * 0.001;
    this.ripples = this.ripples.filter(rp => this._rippleRadius(now, rp) >= 0);

    // joystick raindrops - optimized to reduce lag
    if (this.dropRateHz > 0.001) {
      this.dropClockSec += this._dt;
      const period = 1 / this.dropRateHz;

      // Reduced from 1-4 drops to 1-2 drops per tick for better performance
      const dropsPerTickBase = 1 + Math.floor(Math.min(1, Math.abs(this._jy)) * 1); // 1..2
      while (this.dropClockSec >= period) {
        this.dropClockSec -= period;

        const dropsThisTick = dropsPerTickBase;
        for (let h = 0; h < dropsThisTick; h++) {
          let x, y;
          const rad = this.dropRadius * (0.85 + Math.random() * 0.3);
          if (this.pointerX >= 0 && this.pointerY >= 0) {
            const jitterR = rad * 0.65 * (Math.random() * 0.8);
            const theta = Math.random() * Math.PI * 2;
            x = this.pointerX + Math.cos(theta) * jitterR;
            y = this.pointerY + Math.sin(theta) * jitterR;
          } else {
            x = Math.random() * p.width;
            y = Math.random() * p.height;
          }
          this._spawnRipple(x, y, now, rad);
        }
      }
    } else {
      this.dropClockSec = 0;
    }
  }

  draw(p) {
    if (!this.maskData) return;

    // draw background behind grid
    this._bg.draw(p);

    const cell = this.cell, cols = this.cols, rows = this.rows;
    const tSec = p.millis() * 0.001;
    const gridPhase = this.phaseTick % this.PHASES; this.phaseTick++;

    p.push();
    p.noFill();

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (((gx + gy) % this.PHASES) !== gridPhase) continue;

        const cx = gx * cell + cell * 0.5;
        const cy = gy * cell + cell * 0.5;
        if (!this._isSilhouette(cx, cy, p)) continue;

        const sIdx = (gy * cols + gx) * 4;
        let ox = this.state[sIdx    ];
        let oy = this.state[sIdx + 1];
        let vx = this.state[sIdx + 2];
        let vy = this.state[sIdx + 3];

        // forces
        let fx = 0, fy = 0;

        // hover attraction
        if (this.pointerX >= 0 && this.pointerY >= 0) {
          const dx = this.pointerX - (cx + ox);
          const dy = this.pointerY - (cy + oy);
          const d  = Math.hypot(dx, dy);
          if (d < this.hoverRadius && d > 1e-3) {
            const u = this._smoothstep(1 - d / this.hoverRadius);
            const mag = this.hoverPull * u;
            fx += (dx / d) * mag;
            fy += (dy / d) * mag;
          }
        }

        const now = tSec;

        // ripples
        let colorInfluence = 0;
        for (let r = 0; r < this.ripples.length; r++) {
          const rp = this.ripples[r];
          const rad = this._rippleRadius(now, rp);
          if (rad < 0) continue;

          const dx = (cx + ox) - rp.x;
          const dy = (cy + oy) - rp.y;
          const d  = Math.hypot(dx, dy) || 1e-6;

          if (d < rad) {
            const depth = (rad - d) / Math.max(rad, 1);
            colorInfluence = Math.max(colorInfluence, depth * 0.9);
            const mag = this.INSIDE_PUSH * (0.85 + 0.30 * Math.random()) * depth;
            fx += (dx / d) * mag;
            fy += (dy / d) * mag;

            const age = Math.max(0, now - rp.t0);
            if (age <= this.IMPACT_WINDOW) {
              const kick = this.IMPULSE_VEL * depth;
              vx += (dx / d) * kick;
              vy += (dy / d) * kick;
            }
          } else {
            const age = Math.max(0, now - rp.t0);
            if (age < this.GROW_TIME) {
              const band = Math.abs(d - rad);
              if (band <= this.EDGE_BAND) {
                const u = 1 - band / this.EDGE_BAND;
                colorInfluence = Math.max(colorInfluence, u * 0.6);
                const mag = this.EDGE_PUSH * (0.9 + 0.2 * Math.random()) * u;
                fx += (dx / d) * mag;
                fy += (dy / d) * mag;
              }
            }
          }
        }

        // spring + damping
        fx += -this.springK * ox - this.damping * vx;
        fy += -this.springK * oy - this.damping * vy;

        // integrate
        vx += fx * this._dt; vy += fy * this._dt;
        ox += vx * this._dt; oy += vy * this._dt;

        this.state[sIdx    ] = ox;
        this.state[sIdx + 1] = oy;
        this.state[sIdx + 2] = vx;
        this.state[sIdx + 3] = vy;

        // appearance (NOT audio-reactive)
        const br = this._brightnessAt(cx, cy, p);
        const darkness = 1 - Math.min(Math.max(br / 255, 0), 1);
        const w = this.strokeMin + darkness * (this.strokeMax - this.strokeMin);
        const sizePx = Math.max(this.sizeMin, darkness * (cell * this.sizeMax));
        const angle = tSec * 0.7 + gx * 0.05 - gy * 0.04;
        const lenScale = this.strokeLenScale;
        const rlen = sizePx * 0.5 * lenScale;

        if (!this._jactive) {
          p.stroke(this.strokeColor);
          p.strokeWeight(w);
          p.push(); p.translate(cx + ox, cy + oy); p.rotate(angle);
          p.line(-rlen, 0, rlen, 0);
          p.line(0, -rlen, 0, rlen);
          p.pop();
          continue;
        }

        // ACTIVE (joystick engaged): lightweight color + morph
        const hueCenter = this._hueBase;
        const hue = (hueCenter + this._hueSpan * Math.sin(0.5 * tSec + 0.08 * gx - 0.07 * gy)
                     + this._hueSpan * this._bloom * colorInfluence) % 360;
        const sat = 54 + Math.floor(28 * Math.min(1, colorInfluence * 1.2));
        const lit = 62 + Math.floor(12 * Math.min(1, colorInfluence));
        p.stroke(`hsl(${(hue+360)%360}, ${sat}%, ${lit}%)`);
        p.strokeWeight(w);

        const shapePhase = this._shapePhase * 3.0; // 0..3
        const stage = Math.floor(shapePhase);
        const localT = Math.max(0, Math.min(1, shapePhase - stage));

        p.push();
        p.translate(cx + ox, cy + oy);
        p.rotate(angle);

        if (stage === 0) {
          drawLine(p, rlen);
          if (localT > 0) { p.push(); p.drawingContext.globalAlpha = localT; drawCross(p, rlen); p.pop(); }
        } else if (stage === 1) {
          p.push(); p.drawingContext.globalAlpha = 1 - localT; drawCross(p, rlen);   p.pop();
          p.push(); p.drawingContext.globalAlpha = localT;     drawDiamond(p, rlen); p.pop();
        } else {
          p.push(); p.drawingContext.globalAlpha = 1 - localT; drawDiamond(p, rlen); p.pop();
          p.push(); p.drawingContext.globalAlpha = localT;     drawDot(p, rlen * 0.9); p.pop();
        }

        p.pop();
      }
    }
    p.pop();
  }
}

/* ===== draw helpers (keep stroke state from caller) ===== */
function drawLine(p, len) { p.line(-len, 0, len, 0); }
function drawCross(p, len) { p.line(-len, 0, len, 0); p.line(0, -len, 0, len); }
function drawDiamond(p, len) { p.beginShape(); p.vertex(0, -len); p.vertex(len, 0); p.vertex(0, len); p.vertex(-len, 0); p.endShape(p.CLOSE); }
function drawDot(p, r) { p.circle(0, 0, Math.max(2, r) * 2); }
