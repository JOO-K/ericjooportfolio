// videoparticles.js — Anchors + Floaters + CLICK: Ripple/Spawn
// Joystick:
//   • spawns *rows* of temporary floaters from the opposite edge (lightweight)
//   • drives a noise-based color palette so random connections glow in that palette
//
// Includes:
//   • AudioReactiveVoronoiLayer (c2.js LimitedVoronoi2-inspired) as BG
//   • NEW: “Beads” spawned at some connection midpoints that physically bend lines
//          and exert forces on nearby floaters; beads pulse/jitter with audio

import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';

/* ================================
   Audio-reactive Voronoi background
   ================================ */

class AudioReactiveVoronoiLayer {
  constructor() {
    this.hasC2 = !!window.c2;
    this.canvas = null;
    this.renderer = null;

    this.rng = null;
    this.voronoi = null;
    this.AgentClass = null;
    this.agents = [];

    // look
    this.strokeBase = '#9aa0a6'; // subtle neutral
    this.dotColor   = '#9aa0a6'; // (center points disabled by default)
    this.lineBase   = 0.8;
    this.lineMax    = 2.3;

    this.polySidesMin = 4;
    this.polySidesMax = 7;

    // population
    this.baseAgents = 14;
    this.maxAgents  = 24;

    // envelopes
    this._prevK = 0; this._prevS = 0; this._prevH = 0;
    this.kickImpulse  = 0; // fast pop
    this.snareImpulse = 0; // dash + twist
    this.hatImpulse   = 0; // jitter

    // global fade (on audio presence)
    this.alpha = 0;
    this.fadeSlew = 0.16;
  }

  _bus() {
    const b = window.__AUDIO_BUS || {};
    const clamp = (v) => Math.max(0, Math.min(1, v ?? 0));
    return {
      playing: !!b.playing,
      rms: clamp(b.rms),
      bass: clamp(b.bands?.bass),
      mid: clamp(b.bands?.mid),
      treble: clamp(b.bands?.treble),
      k: clamp(b.kick), s: clamp(b.snare), h: clamp(b.hat),
    };
  }

  _bgColorString() {
    const bg = (typeof CONFIG?.BG_COLOR === 'number')
      ? `#${(CONFIG.BG_COLOR >>> 0).toString(16).padStart(6,'0')}`
      : (CONFIG?.BG_COLOR || '#0e111a');
    return bg;
  }

  _ensureInit(p) {
    if (!this.hasC2) return false;
    const c2 = window.c2;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width  = Math.max(1, p.width | 0);
      this.canvas.height = Math.max(1, p.height | 0);
    }
    if (!this.renderer) {
      this.renderer = new c2.Renderer(this.canvas);
      this.renderer.background(false);
      this.rng = new c2.Random();
      this.voronoi = new c2.LimitedVoronoi();

      const self = this;
      this.AgentClass = class Agent extends c2.Cell {
        constructor() {
          const W = self.canvas.width, H = self.canvas.height;
          const x = self.rng.next(0, W);
          const y = self.rng.next(0, H);
          const r = self.rng.next(W / 40, W / 18);
          super(x, y, r);
          this.vx = self.rng.next(-1.4, 1.4);
          this.vy = self.rng.next(-1.4, 1.4);
          this._baseR = r;
        }
        step(dt, W, H, velMul, jitter) {
          this.vx += (Math.random() - 0.5) * 0.08 * jitter;
          this.vy += (Math.random() - 0.5) * 0.08 * jitter;
          this.p.x += this.vx * velMul * dt * 60;
          this.p.y += this.vy * velMul * dt * 60;
          if (this.p.x < 0) { this.p.x = 0; this.vx *= -1; }
          else if (this.p.x > W) { this.p.x = W; this.vx *= -1; }
          if (this.p.y < 0) { this.p.y = 0; this.vy *= -1; }
          else if (this.p.y > H) { this.p.y = H; this.vy *= -1; }
        }
      };

      this._seed();
    }
    return true;
  }

  _seed() {
    if (!this.AgentClass) return;
    const want = this.baseAgents;
    this.agents = [];
    for (let i = 0; i < want; i++) this.agents.push(new this.AgentClass());
  }

  setup(p) { this._ensureInit(p); }
  resize(p) {
    if (!this._ensureInit(p)) return;
    this.canvas.width  = Math.max(1, p.width | 0);
    this.canvas.height = Math.max(1, p.height | 0);
    this.renderer.size(this.canvas.width, this.canvas.height);
    this._seed();
  }

  _updateEnvelopes(bus) {
    if (bus.k > 0.55 && this._prevK <= 0.55) this.kickImpulse = 1.0;
    if (bus.s > 0.52 && this._prevS <= 0.52) this.snareImpulse = 1.0;
    if (bus.h > 0.50 && this._prevH <= 0.50) this.hatImpulse = 1.0;

    this.kickImpulse  *= 0.90;
    this.snareImpulse *= 0.90;
    this.hatImpulse   *= 0.92;

    this._prevK = bus.k; this._prevS = bus.s; this._prevH = bus.h;
  }

  update(p, dt) {
    if (!this._ensureInit(p)) return;

    const bus = this._bus();
    const dtC = Math.max(0.016, dt || 0.016);

    const alive = bus.playing || bus.rms > 0.02;
    this.alpha += ((alive ? 1 : 0) - this.alpha) * this.fadeSlew;
    if (this.alpha < 0.01) return;

    this._updateEnvelopes(bus);

    const want = Math.min(this.maxAgents, Math.round(this.baseAgents + 6 * (bus.rms + 0.6 * bus.mid)));
    while (this.agents.length < want) this.agents.push(new this.AgentClass());
    while (this.agents.length > want) this.agents.pop();

    const W = this.canvas.width, H = this.canvas.height;
    const velMul = 0.9 + 1.6 * bus.bass + 0.4 * this.kickImpulse;
    const jitter = 1.0 + 1.6 * (bus.h + 0.5 * this.hatImpulse);
    for (const A of this.agents) A.step(dtC, W, H, velMul, jitter);

    for (const A of this.agents) {
      const target = A._baseR * (1 + 0.55 * this.kickImpulse + 0.25 * bus.bass);
      A.r += (target - A.r) * 0.25;
    }

    this.voronoi.compute(this.agents);

    this.renderer.clear();

    const lw = this.lineBase + (this.lineMax - this.lineBase) * (0.55 * this.kickImpulse + 0.20 * bus.treble);
    this.renderer.lineWidth(lw);
    if (this.renderer.lineDash) {
      if (this.snareImpulse > 0.12) this.renderer.lineDash([6 + Math.round(8 * this.snareImpulse), 6]);
      else this.renderer.lineDash(false);
    }

    this.renderer.stroke(this.strokeBase);
    this.renderer.fill(false);
    for (const A of this.agents) this.renderer.cell(A);

    const sides = Math.round(this.polySidesMin + (this.polySidesMax - this.polySidesMin) * (0.35 + 0.65 * bus.treble));
    this.renderer.fill(this._bgColorString());
    this.renderer.stroke(this.strokeBase);
    this.renderer.lineWidth(Math.max(0.7, lw * 0.9));

    for (const A of this.agents) {
      if (A.state === 2) continue;
      const poly = A.polygon(sides);
      this.renderer.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const pt = poly[i];
        if (i === 0 && this.renderer.moveTo) this.renderer.moveTo(pt.x, pt.y);
        else this.renderer.lineTo(pt.x, pt.y);
      }
      this.renderer.endPath(true); // fill + stroke
    }
  }

  draw(p) {
    if (!this.hasC2 || !this.canvas || this.alpha < 0.01) return;
    p.push();
    try {
      p.drawingContext.save();
      p.drawingContext.globalAlpha = this.alpha;
      p.drawingContext.drawImage(this.canvas, 0, 0, p.width, p.height);
      p.drawingContext.restore();
    } catch(_) {}
    p.pop();
  }
}

/* ================================
   Original Connected Particles effect
   ================================ */

class Floater {
  constructor(x, y, speed, bornSec = 0, lifeSec = Infinity, vxKick = 0, vyKick = 0) {
    this.x = x; this.y = y;
    this.vx = (Math.random() - 0.5) * speed + vxKick;
    this.vy = (Math.random() - 0.5) * speed + vyKick;
    this.ax = 0; this.ay = 0;
    this.born = bornSec;
    this.life = lifeSec; // seconds
  }
  step(dt, drag) {
    this.vx = (this.vx + this.ax * dt) * drag;
    this.vy = (this.vy + this.ay * dt) * drag;
    this.x  += this.vx * dt;
    this.y  += this.vy * dt;
    this.ax = 0; this.ay = 0;
  }
  isExpired(nowSec) { return (nowSec - this.born) > this.life; }
}

function makeRipple(x, y, tSec, hue) {
  return { x, y, t0: tSec, hue };
}

// ==== BEADS: midpoint objects that bend lines + push/pull floaters
class Bead {
  constructor(x, y, born, life, rBase) {
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.born = born;
    this.life = life;   // seconds
    this.rBase = rBase; // base radius (px)
    this.r = rBase;
  }
  age(now) { return Math.max(0, now - this.born); }
  alive(now) { return this.age(now) < this.life; }
}

export class VideoConnectedParticlesEffect {
  constructor() {
    this.name = 'Video Connected Particles (Anchors + Floaters + Ripple + Joystick Colors/Rows + Beads)';

    // video & mask
    this.video = null;
    this.maskData = null;

    // ----- Voronoi BG layer -----
    this._vor = new AudioReactiveVoronoiLayer();

    // ----- Anchors (fixed grid) -----
    this.anchorCols = 40;
    this.anchorRows = 22;
    this.anchorSize = 2;
    this.anchorColor = 230;
    this.anchors = [];

    // ----- Floaters (moving, invisible) - REDUCED for performance -----
    this.floaterCount = 80;
    this.floaterSpeed = 60;
    this.drag         = 0.985;
    this.noiseAmp     = 26;
    this.noiseScale   = 0.0025;
    this.noiseTime    = 0.16;
    this.floaters = [];
    this._t = 0;

    // ----- Connections -----
    this.linkDist = 110;
    this.lineBase = 0.7;
    this.lineMax  = 2.1;

    // Spatial hashing for floaters
    this._bucketSize = this.linkDist;
    this._buckets = new Map();

    // ----- Color ripple (click/tap) -----
    this.RIPPLE_SPEED = 600;   // px/s
    this.RIPPLE_WIDTH = 18;    // px
    this.RIPPLE_FADE  = 0.65;  // 0..1
    this.MAX_RIPPLES  = 6;
    this.ripples = [];

    // ----- Floater spawn on click/tap (REDUCED for performance) -----
    this.SPAWN_ON_CLICK_COUNT = 4;   // Reduced from 12 to 4
    this.FLOATER_LIFETIME_SEC = 3.0; // Reduced from 4.0 to 3.0
    this.FLOATER_MAX          = 100; // Reduced from 180 to 100
    this.SPAWN_RADIUS         = 60;
    this.SPAWN_SPEED_BOOST    = 120;

    // ----- Joystick controls particle density (not row spawning) -----
    this._joyActive = false;
    this._joyDir = 'center';
    this._joyMag = 0;
    this._joyX = 0;
    this._joyY = 0;

    // ----- Joystick-driven color palette -----
    this.paletteCenter = 210;
    this.paletteWidth  = 40;
    this.colorNoiseScale = 0.0018;
    this.colorBaseFraction = 0.18;
    this.colorMaxBoost     = 0.55;
    this.colorAlpha        = 170;

    // ==== BEADS: params - REDUCED for performance
    this.beads = [];
    this.BEAD_MAX = 40;
    this.BEAD_LIFE = 2.5;          // seconds
    this.BEAD_BASE_R = 6;          // px base radius
    this.BEAD_RANGE = 90;          // influence radius
    this.BEAD_FORCE = 1400;        // N-ish (tuned)
    this.BEAD_SPAWN_PER_SEC = 8;   // average spawns per sec (capped by MAX)
    this._beadClock = 0;
  }

  // joystick - controls particle density and connection distance
  onJoystick({ x = 0, y = 0, dir = 'center', mag = 0, active = false } = {}) {
    this._joyDir = dir || 'center';
    this._joyMag = Math.max(0, Math.min(1, mag || 0));
    this._joyActive = !!active || this._joyMag > 0.12;
    this._joyX = Math.max(-1, Math.min(1, x || 0));
    this._joyY = Math.max(-1, Math.min(1, y || 0));

    // Color palette based on direction
    switch (this._joyDir) {
      case 'up':    this.paletteCenter = 210; this.paletteWidth = 35; break;
      case 'right': this.paletteCenter = 15;  this.paletteWidth = 30; break;
      case 'down':  this.paletteCenter = 95;  this.paletteWidth = 35; break;
      case 'left':  this.paletteCenter = 310; this.paletteWidth = 30; break;
      default: break;
    }
  }

  preload(p) {}

  setup(p) {
    const isMobile = p.windowWidth <= 800;
    this.video = new VideoPlaylist({ isMobile });
    this.video.init(p.width, p.height);

    // voronoi bg
    this._vor.setup(p);

    this._seedAnchors(p);
    this._seedFloaters(p);

    p.strokeCap(p.ROUND);
    p.strokeJoin(p.ROUND);

    // pointer/click → ripple + spawn
    const canvas = p._renderer?.elt || p.canvas;
    const toCanvasXY = (clientX, clientY) => {
      const r = canvas.getBoundingClientRect();
      const sx = p.width / r.width, sy = p.height / r.height;
      return { x: (clientX - r.left) * sx, y: (clientY - r.top) * sy };
    };
    const onPress = (clientX, clientY) => {
      const { x, y } = toCanvasXY(clientX, clientY);
      const tSec = p.millis() * 0.001;
      // ripple
      const hue = Math.floor(Math.random() * 360);
      this.ripples.push(makeRipple(x, y, tSec, hue));
      if (this.ripples.length > this.MAX_RIPPLES) this.ripples.shift();
      // floater spawn
      this.spawnFloatersAt(p, x, y, tSec);
      // bead at click (bonus)
      this._spawnBead(x, y, tSec);
    };

    canvas.addEventListener('pointerdown', e => onPress(e.clientX, e.clientY), { passive: true });
    canvas.addEventListener('touchstart',  e => { const t = e.touches[0]; if (t) onPress(t.clientX, t.clientY); }, { passive: true });
  }

  dispose() { this.video?.dispose?.(); }

  resize(p) {
    this.video?.resize(p.width, p.height);
    this._vor.resize(p);
    this._seedAnchors(p);
    // keep current floaters and beads
  }

  // ---------- Seeding ----------
  _seedAnchors(p) {
    const cols = (p.windowWidth <= 800) ? Math.floor(this.anchorCols * 0.6) : this.anchorCols;
    const rows = (p.windowWidth <= 800) ? Math.floor(this.anchorRows * 0.6) : this.anchorRows;

    this.anchors = [];
    const stepX = p.width  / (cols + 1);
    const stepY = p.height / (rows + 1);
    for (let j = 1; j <= rows; j++) {
      for (let i = 1; i <= cols; i++) {
        const x = i * stepX;
        const y = j * stepY;
        this.anchors.push({ x, y });
      }
    }
  }

  _seedFloaters(p) {
    const base = (p.windowWidth <= 800) ? Math.floor(this.floaterCount * 0.6) : this.floaterCount;
    const N = base;
    this.floaters = [];
    const nowSec = p.millis() * 0.001;
    for (let i = 0; i < N; i++) {
      const x = Math.random() * p.width;
      const y = Math.random() * p.height;
      this.floaters.push(new Floater(x, y, this.floaterSpeed, nowSec, Infinity));
    }
  }

  // ---------- Beads ----------
  _spawnBead(x, y, nowSec) {
    if (this.beads.length >= this.BEAD_MAX) return;
    this.beads.push(new Bead(x, y, nowSec, this.BEAD_LIFE, this.BEAD_BASE_R));
  }
  _pruneBeads(now) {
    this.beads = this.beads.filter(b => b.alive(now));
  }
  _nearestBead(x, y, maxR) {
    let best = null, bestD2 = (maxR*maxR);
    for (let i = 0; i < this.beads.length; i++) {
      const b = this.beads[i];
      const dx = x - b.x, dy = y - b.y;
      const d2 = dx*dx + dy*dy;
      if (d2 <= bestD2) { bestD2 = d2; best = b; }
    }
    return best ? { bead: best, d2: bestD2 } : null;
  }

  // ---------- Spawn helpers ----------
  spawnFloatersAt(p, x, y, nowSec) {
    for (let i = 0; i < this.SPAWN_ON_CLICK_COUNT; i++) {
      const r = Math.random() * this.SPAWN_RADIUS;
      const a = Math.random() * Math.PI * 2;
      const sx = x + Math.cos(a) * r;
      const sy = y + Math.sin(a) * r;

      const f = new Floater(sx, sy, this.floaterSpeed + this.SPAWN_SPEED_BOOST, nowSec, this.FLOATER_LIFETIME_SEC);
      f.vx += Math.cos(a) * this.SPAWN_SPEED_BOOST;
      f.vy += Math.sin(a) * this.SPAWN_SPEED_BOOST;

      this.floaters.push(f);
    }
    if (this.floaters.length > this.FLOATER_MAX) {
      this._cullFloaters(p, nowSec, this.floaters.length - this.FLOATER_MAX);
    }
  }

  _spawnRowFromEdge(p, side, nowSec, intensity01) {
    const spacing = Math.max(22, Math.min(34, this.ROW_SPACING * (0.9 + 0.4 * intensity01)));
    const jitter  = spacing * 0.22;

    if (side === 'left' || side === 'right') {
      const yCount = Math.ceil(p.height / spacing);
      const x = (side === 'left') ? -8 : (p.width + 8);
      const vx = (side === 'left') ? this.ROW_SPEED : -this.ROW_SPEED;
      for (let i = 0; i <= yCount; i++) {
        const y = i * spacing + (Math.random() - 0.5) * jitter;
        const f = new Floater(x, y, 0, nowSec, this.ROW_LIFE_SEC, vx * (0.85 + 0.4 * Math.random()), (Math.random() - 0.5) * 40);
        this.floaters.push(f);
      }
    } else {
      const xCount = Math.ceil(p.width / spacing);
      const y = (side === 'top') ? -8 : (p.height + 8);
      const vy = (side === 'top') ? this.ROW_SPEED : -this.ROW_SPEED;
      for (let i = 0; i <= xCount; i++) {
        const x = i * spacing + (Math.random() - 0.5) * jitter;
        const f = new Floater(x, y, 0, nowSec, this.ROW_LIFE_SEC, (Math.random() - 0.5) * 40, vy * (0.85 + 0.4 * Math.random()));
        this.floaters.push(f);
      }
    }
    if (this.floaters.length > this.FLOATER_MAX) {
      this._cullFloaters(p, nowSec, this.floaters.length - this.FLOATER_MAX);
    }
  }

  _cullFloaters(p, nowSec, removeExtra = 0) {
    let keep = [];
    for (let i = 0; i < this.floaters.length; i++) {
      const f = this.floaters[i];
      if (f.life !== Infinity && f.isExpired(nowSec)) continue;
      keep.push(f);
    }
    if (removeExtra > 0) {
      const perm = [], temp = [];
      for (const f of keep) (f.life === Infinity ? perm : temp).push(f);
      while (removeExtra-- > 0 && temp.length) temp.shift();
      keep = perm.concat(temp);
    }
    this.floaters = keep;
  }

  // ---------- Mask helpers ----------
  _brightnessAt(px, py, p) {
    const m = this.maskData;
    if (!m) return 255;
    const x = px | 0, y = py | 0;
    if (x < 0 || y < 0 || x >= p.width || y >= p.height) return 255;
    const i = (y * p.width + x) << 2;
    const a = m[i + 3]; if (a < 8) return 255;
    const r = m[i], g = m[i + 1], b = m[i + 2];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  _anchorInside(px, py, p) {
    if (this.video?.isSilhouetteAt)
      return this.video.isSilhouetteAt(this.maskData, p.width, p.height, px, py);
    return this._brightnessAt(px, py, p) < CONFIG.VIDEO.SIL_BRIGHTNESS_THRESHOLD;
  }

  // ---------- Spatial hashing for floaters ----------
  _bucketKey(cx, cy) { return cx + ',' + cy; }
  _rebuildBuckets(p) {
    this._buckets.clear();
    const s = this._bucketSize;
    for (let i = 0; i < this.floaters.length; i++) {
      const f = this.floaters[i];
      const cx = Math.floor(f.x / s);
      const cy = Math.floor(f.y / s);
      const key = this._bucketKey(cx, cy);
      let arr = this._buckets.get(key);
      if (!arr) this._buckets.set(key, (arr = []));
      arr.push(i);
    }
  }
  _nearbyFloaters(x, y) {
    const s = this._bucketSize;
    const cx = Math.floor(x / s);
    const cy = Math.floor(y / s);
    const out = [];
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const key = this._bucketKey(cx + i, cy + j);
        const arr = this._buckets.get(key);
        if (arr) out.push(...arr);
      }
    }
    return out;
  }

  // ---------- Update ----------
  update(p, dtMs) {
    // refresh mask
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;

    const dt = Math.max(0.001, Math.min(0.033, (dtMs || 16.7) / 1000));
    const nowSec = p.millis() * 0.001;
    this._t += dt * this.noiseTime;

    // update voronoi bg (FIRST so it draws behind)
    this._vor.update(p, dt);

    // Joystick controls connection distance: UP increases, DOWN decreases
    const baseLink = 110;
    const linkMod = this._joyY * 50; // -50 to +50
    this.linkDist = Math.max(60, Math.min(160, baseLink - linkMod));
    this._bucketSize = this.linkDist;

    // Move floaters with noise flow + wrap bounds
    for (let i = 0; i < this.floaters.length; i++) {
      const fl = this.floaters[i];
      const nx = p.noise(fl.x * this.noiseScale, fl.y * this.noiseScale, this._t);
      const ny = p.noise(fl.y * this.noiseScale, fl.x * this.noiseScale, this._t + 10);
      const ang = (nx - 0.5) * Math.PI * 2 * 0.12 + (ny - 0.5) * Math.PI * 2 * 0.12;

      fl.ax += Math.cos(ang) * (this.noiseAmp * 0.58);
      fl.ay += Math.sin(ang) * (this.noiseAmp * 0.58);

      // ==== BEADS: bead forces on floaters
      for (let b = 0; b < this.beads.length; b++) {
        const bead = this.beads[b];
        const dx = fl.x - bead.x, dy = fl.y - bead.y;
        const d2 = dx*dx + dy*dy;
        const range = this.BEAD_RANGE;
        if (d2 < range*range) {
          const d = Math.max(1, Math.sqrt(d2));
          // audio-driven: kick repels stronger, snare slightly attracts, hats add jitter
          const dir = (this._kickLevel ?? 0) >= 0.3 ? 1 : -0.6; // 1=repel, -0.6=attract-ish
          const baseF = this.BEAD_FORCE * (0.6 + (this._kickLevel ?? 0.0) * 1.2);
          const F = baseF * (1 - (d / range));
          fl.ax += (dx / d) * F * dir;
          fl.ay += (dy / d) * F * dir;
        }
      }

      fl.step(dt, this.drag);

      if (fl.x < -6) fl.x = p.width + 6;
      else if (fl.x > p.width + 6) fl.x = -6;
      if (fl.y < -6) fl.y = p.height + 6;
      else if (fl.y > p.height + 6) fl.y = -6;
    }

    // Periodic cull and bucket rebuild
    this._cullFloaters(p, nowSec, Math.max(0, this.floaters.length - this.FLOATER_MAX));
    this._rebuildBuckets(p);

    // ==== BEADS: spawn a few from random existing connections per second (scaled by RMS)
    const rms = (window.__AUDIO_BUS?.rms || 0);
    const spawnRate = this.BEAD_SPAWN_PER_SEC * (0.4 + 1.2 * rms); // 7..~40/s
    const period = spawnRate > 0.001 ? (1 / spawnRate) : Infinity;
    this._beadClock += dt;
    while (this._beadClock >= period && this.beads.length < this.BEAD_MAX) {
      this._beadClock -= period;
      // pick a random anchor, find nearest floater via buckets, make midpoint
      if (this.anchors.length && this.floaters.length) {
        const ai = Math.floor(Math.random() * this.anchors.length);
        const a = this.anchors[ai];
        const cand = this._nearbyFloaters(a.x, a.y);
        if (cand.length) {
          const fi = this.floaters[cand[Math.floor(Math.random() * cand.length)]];
          const f = this.floaters[fi] || this.floaters[0];
          const mx = 0.5 * (a.x + f.x);
          const my = 0.5 * (a.y + f.y);
          this._spawnBead(mx, my, nowSec);
        }
      }
    }

    // ==== BEADS: update bead size/position from audio + gentle drift; prune
    const bus = window.__AUDIO_BUS || {};
    const kick = Math.max(0, Math.min(1, bus.kick || 0));
    const hat  = Math.max(0, Math.min(1, bus.hat  || 0));
    const snr  = Math.max(0, Math.min(1, bus.snare|| 0));
    this._kickLevel = kick; // used in force sign above

    for (let i = 0; i < this.beads.length; i++) {
      const b = this.beads[i];
      // radius pulses with kick; tiny tremor with hats
      const targetR = this.BEAD_BASE_R * (1 + 1.5 * kick) + Math.sin(nowSec * 22 + i) * (1.5 * hat);
      b.r += (targetR - b.r) * 0.22;

      // slight snare twist drift
      b.vx += (Math.random() - 0.5) * (14 * (0.2 + hat));
      b.vy += (Math.random() - 0.5) * (14 * (0.2 + hat));
      b.x += b.vx * 0.016 * (0.5 + 0.8 * snr);
      b.y += b.vy * 0.016 * (0.5 + 0.8 * snr);

      // mild damping
      b.vx *= 0.94; b.vy *= 0.94;
    }
    this._pruneBeads(nowSec);

    p.background(CONFIG.BG_COLOR);
  }

  // ---------- Draw ----------
  draw(p) {
    const nowSec = p.millis() * 0.001;

    // BACKGROUND: voronoi
    this._vor.draw(p);

    const R  = this.linkDist;
    const R2 = R * R;

    // draw anchors (only ones inside silhouette)
    p.noStroke();
    p.fill(this.anchorColor);
    for (let k = 0; k < this.anchors.length; k++) {
      const a = this.anchors[k];
      if (!this._anchorInside(a.x, a.y, p)) continue;
      p.circle(a.x, a.y, this.anchorSize);
    }

    // Prepare HSL for color palette lines
    p.push();
    p.colorMode(p.HSL, 360, 100, 100, 255);

    const coloredFrac = this.colorBaseFraction + this.colorMaxBoost * this._joyMag;
    const hueCenter   = this.paletteCenter;
    const hueWidth    = this.paletteWidth;

    // draw connections (with bead-curved lines if near a bead)
    for (let k = 0; k < this.anchors.length; k++) {
      const a = this.anchors[k];
      if (!this._anchorInside(a.x, a.y, p)) continue;

      const candidates = this._nearbyFloaters(a.x, a.y);
      for (let idx = 0; idx < candidates.length; idx++) {
        const fi = candidates[idx];
        const b = this.floaters[fi];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx*dx + dy*dy;
        if (d2 > R2) continue;

        const d = Math.sqrt(d2);
        const t = 1 - d / R; // 0..1 proximity
        const w = this.lineBase + t * (this.lineMax - this.lineBase);

        // midpoint
        const mx = 0.5 * (a.x + b.x);
        const my = 0.5 * (a.y + b.y);

        // choose color (ripple or palette)
        let setColor = false;
        for (let rp of this.ripples) {
          const age = Math.max(0, nowSec - rp.t0);
          const radius = age * this.RIPPLE_SPEED;
          const dist = Math.hypot(mx - rp.x, my - rp.y);
          if (Math.abs(dist - radius) <= this.RIPPLE_WIDTH) {
            p.stroke(rp.hue, 80, 60, Math.min(255, 255 * this.RIPPLE_FADE));
            setColor = true;
            break;
          }
        }
        if (!setColor) {
          const n = p.noise(mx * this.colorNoiseScale, my * this.colorNoiseScale, this._t * 0.8);
          if (n < coloredFrac) {
            const h = hueCenter + (n - 0.5) * 2 * hueWidth;
            const sat = 75 + Math.min(20, 25 * this._joyMag);
            const lit = 55 + 10 * (1 - t);
            p.stroke((h + 360) % 360, sat, lit, this.colorAlpha);
            setColor = true;
          }
        }
        if (!setColor) {
          p.stroke(0, 0, 90, 160);
        }

        p.strokeWeight(w);

        // ==== BEADS: curve toward nearest bead if close
        const hit = this._nearestBead(mx, my, this.BEAD_RANGE * 0.9);
        if (hit) {
          const bead = hit.bead;
          // control point toward bead, pulled a bit past midpoint
          const cx = mx + (bead.x - mx) * 0.9;
          const cy = my + (bead.y - my) * 0.9;

          p.noFill();
          p.beginShape();
          p.vertex(a.x, a.y);
          p.quadraticVertex(cx, cy, b.x, b.y);
          p.endShape();

          // bead disc (BG fill) creates occlusion feel
          p.noStroke();
          p.fill(CONFIG.BG_COLOR);
          p.circle(bead.x, bead.y, bead.r * 2);

          // subtle outline for bead
          p.stroke(0, 0, 85, 140);
          p.strokeWeight(1);
          p.noFill();
          p.circle(bead.x, bead.y, bead.r * 2 + 1);
        } else {
          // straight fallback
          p.line(a.x, a.y, b.x, b.y);
        }
      }
    }

    p.pop();

    // prune old ripples
    const maxR = Math.hypot(p.width, p.height);
    this.ripples = this.ripples.filter(rp => (nowSec - rp.t0) * this.RIPPLE_SPEED < maxR + 200);
  }
}

export default VideoConnectedParticlesEffect;
