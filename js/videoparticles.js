// videoparticles.js — Anchors + Floaters + CLICK: Ripple/Spawn
// Joystick:
//   • spawns *rows* of temporary floaters from the opposite edge (lightweight)
//   • drives a noise-based color palette so random connections glow in that palette

import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';

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

export class VideoConnectedParticlesEffect {
  constructor() {
    this.name = 'Video Connected Particles (Anchors + Floaters + Ripple + Joystick Colors/Rows)';

    // video & mask
    this.video = null;
    this.maskData = null;

    // ----- Anchors (fixed grid) -----
    this.anchorCols = 40;
    this.anchorRows = 22;
    this.anchorSize = 2;
    this.anchorColor = 230;
    this.anchors = [];

    // ----- Floaters (moving, invisible) -----
    this.floaterCount = 160;   // lighter (half-ish) for perf
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

    // ----- Floater spawn on click/tap (lighter) -----
    this.SPAWN_ON_CLICK_COUNT = 20;
    this.FLOATER_LIFETIME_SEC = 5.0;
    this.FLOATER_MAX          = 300;
    this.SPAWN_RADIUS         = 60;
    this.SPAWN_SPEED_BOOST    = 120;

    // ----- Joystick row spawner (lightweight) -----
    this._joyActive = false;
    this._joyDir = 'center';    // 'left'|'right'|'up'|'down'|'center'
    this._joyMag = 0;           // 0..1
    this.ROW_RATE_MAX = 3.5;    // rows/sec at full deflection (light)
    this.ROW_LIFE_SEC = 3.0;
    this.ROW_SPEED    = 460;
    this.ROW_SPACING  = 28;
    this._rowClock    = 0;

    // ----- Joystick-driven color palette -----
    // We generate hue from noise around a palette center; joystick picks the band.
    // Up: blue/cyan, Right: red/orange, Down: green/yellow, Left: magenta/purple
    this.paletteCenter = 210;   // start bluish
    this.paletteWidth  = 40;    // half-range on each side
    this.colorNoiseScale = 0.0018; // larger scale = broader patches
    this.colorBaseFraction = 0.18;  // baseline fraction colored when stick centered
    this.colorMaxBoost     = 0.55;  // extra fraction when mag=1
    this.colorAlpha        = 170;   // alpha for colored lines
  }

  // called by app.js joystick
  // we only need dir + magnitude; app already provides those.
  onJoystick({ dir = 'center', mag = 0, active = false } = {}) {
    this._joyDir = dir || 'center';
    this._joyMag = Math.max(0, Math.min(1, mag || 0));
    this._joyActive = !!active || this._joyMag > 0.12; // mild deadzone

    // map cardinal dir to palette center/width
    switch (this._joyDir) {
      case 'up':    // blue/cyan ~ 190–230
        this.paletteCenter = 210; this.paletteWidth = 35;
        break;
      case 'right': // red/orange ~ 0–40
        this.paletteCenter = 15;  this.paletteWidth = 30;
        break;
      case 'down':  // green/yellow ~ 70–120
        this.paletteCenter = 95;  this.paletteWidth = 35;
        break;
      case 'left':  // pink/purple ~ 290–330
        this.paletteCenter = 310; this.paletteWidth = 30;
        break;
      default:      // centered: keep prior, but we’ll color fewer lines
        break;
    }
  }

  preload(p) {}

  setup(p) {
    const isMobile = p.windowWidth <= 800;
    this.video = new VideoPlaylist({ isMobile });
    this.video.init(p.width, p.height);

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
    };

    canvas.addEventListener('pointerdown', e => onPress(e.clientX, e.clientY), { passive: true });
    canvas.addEventListener('touchstart',  e => { const t = e.touches[0]; if (t) onPress(t.clientX, t.clientY); }, { passive: true });
  }

  dispose() { this.video?.dispose?.(); }

  resize(p) {
    this.video?.resize(p.width, p.height);
    this._seedAnchors(p);
    // keep current floaters; no need to reseed on resize
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
    const N = (p.windowWidth <= 800) ? Math.floor(this.floaterCount * 0.7) : this.floaterCount;
    this.floaters = [];
    const nowSec = p.millis() * 0.001;
    for (let i = 0; i < N; i++) {
      const x = Math.random() * p.width;
      const y = Math.random() * p.height;
      this.floaters.push(new Floater(x, y, this.floaterSpeed, nowSec, Infinity));
    }
  }

  // ---------- Spawn helpers ----------
  spawnFloatersAt(p, x, y, nowSec) {
    for (let i = 0; i < this.SPAWN_ON_CLICK_COUNT; i++) {
      // spawn in a disk around (x,y)
      const r = Math.random() * this.SPAWN_RADIUS;
      const a = Math.random() * Math.PI * 2;
      const sx = x + Math.cos(a) * r;
      const sy = y + Math.sin(a) * r;

      const f = new Floater(sx, sy, this.floaterSpeed + this.SPAWN_SPEED_BOOST, nowSec, this.FLOATER_LIFETIME_SEC);
      // outward kick
      f.vx += Math.cos(a) * this.SPAWN_SPEED_BOOST;
      f.vy += Math.sin(a) * this.SPAWN_SPEED_BOOST;

      this.floaters.push(f);
    }
    // Enforce cap (drop expired first; then temp oldest)
    if (this.floaters.length > this.FLOATER_MAX) {
      this._cullFloaters(p, nowSec, this.floaters.length - this.FLOATER_MAX);
    }
  }

  // Spawn a full *row* of temp floaters from an edge, moving inward.
  _spawnRowFromEdge(p, side, nowSec, intensity01) {
    // spacing across the edge
    const spacing = Math.max(22, Math.min(34, this.ROW_SPACING * (0.9 + 0.4 * intensity01)));
    const jitter  = spacing * 0.22;

    let count = 0;
    if (side === 'left' || side === 'right') {
      const yCount = Math.ceil(p.height / spacing);
      const x = (side === 'left') ? -8 : (p.width + 8);
      const vx = (side === 'left') ? this.ROW_SPEED : -this.ROW_SPEED;
      for (let i = 0; i <= yCount; i++) {
        const y = i * spacing + (Math.random() - 0.5) * jitter;
        const f = new Floater(
          x, y,
          /* base speed */ 0,
          nowSec,
          this.ROW_LIFE_SEC,
          /* inward kick */ vx * (0.85 + 0.4 * Math.random()),
          (Math.random() - 0.5) * 40
        );
        this.floaters.push(f);
        count++;
      }
    } else if (side === 'top' || side === 'bottom') {
      const xCount = Math.ceil(p.width / spacing);
      const y = (side === 'top') ? -8 : (p.height + 8);
      const vy = (side === 'top') ? this.ROW_SPEED : -this.ROW_SPEED;
      for (let i = 0; i <= xCount; i++) {
        const x = i * spacing + (Math.random() - 0.5) * jitter;
        const f = new Floater(
          x, y,
          0,
          nowSec,
          this.ROW_LIFE_SEC,
          (Math.random() - 0.5) * 40,
          vy * (0.85 + 0.4 * Math.random())
        );
        this.floaters.push(f);
        count++;
      }
    }

    // enforce cap (prefer keeping permanents)
    if (this.floaters.length > this.FLOATER_MAX) {
      this._cullFloaters(p, nowSec, this.floaters.length - this.FLOATER_MAX);
    }
    return count;
  }

  _cullFloaters(p, nowSec, removeExtra = 0) {
    // Remove expired
    let keep = [];
    for (let i = 0; i < this.floaters.length; i++) {
      const f = this.floaters[i];
      if (f.life !== Infinity && f.isExpired(nowSec)) continue;
      keep.push(f);
    }
    // If still too many, drop temporary ones first
    if (removeExtra > 0) {
      const perm = [];
      const temp = [];
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

    // Joystick row spawns (light)
    if (this._joyActive && this._joyDir !== 'center') {
      const rate = this.ROW_RATE_MAX * Math.min(1, Math.max(0, this._joyMag)); // rows/sec
      const period = (rate > 0.001) ? (1 / rate) : Infinity;
      this._rowClock += dt;
      while (this._rowClock >= period) {
        this._rowClock -= period;
        // Opposite edge of joystick direction
        const side = (this._joyDir === 'left')  ? 'right'
                    : (this._joyDir === 'right') ? 'left'
                    : (this._joyDir === 'up')    ? 'bottom'
                    : (this._joyDir === 'down')  ? 'top'
                    : 'top';
        this._spawnRowFromEdge(p, side, nowSec, this._joyMag);
      }
    } else {
      this._rowClock = 0;
    }

    // Move floaters with noise flow + wrap bounds
    for (let i = 0; i < this.floaters.length; i++) {
      const fl = this.floaters[i];
      // keep row floaters fairly straight but still alive
      const nx = p.noise(fl.x * this.noiseScale, fl.y * this.noiseScale, this._t);
      const ny = p.noise(fl.y * this.noiseScale, fl.x * this.noiseScale, this._t + 10);
      const ang = (nx - 0.5) * Math.PI * 2 * 0.12 + (ny - 0.5) * Math.PI * 2 * 0.12;

      fl.ax += Math.cos(ang) * (this.noiseAmp * 0.58);
      fl.ay += Math.sin(ang) * (this.noiseAmp * 0.58);

      fl.step(dt, this.drag);

      // wrap around edges to keep constant density
      if (fl.x < -6) fl.x = p.width + 6;
      else if (fl.x > p.width + 6) fl.x = -6;
      if (fl.y < -6) fl.y = p.height + 6;
      else if (fl.y > p.height + 6) fl.y = -6;
    }

    // Periodic cull of expired floaters (and enforce max if needed)
    this._cullFloaters(p, nowSec, Math.max(0, this.floaters.length - this.FLOATER_MAX));

    // build spatial buckets for fast anchor->floater queries
    this._rebuildBuckets(p);

    p.background(CONFIG.BG_COLOR);
  }

  // ---------- Draw ----------
  draw(p) {
    const nowSec = p.millis() * 0.001;

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

    // fraction of colored lines based on joystick magnitude
    const coloredFrac = this.colorBaseFraction + this.colorMaxBoost * this._joyMag;
    const hueCenter   = this.paletteCenter;
    const hueWidth    = this.paletteWidth;

    // draw connections from each inside anchor to nearby floaters
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

        // midpoint of the segment — used for ripple + noise color field
        const mx = 0.5 * (a.x + b.x);
        const my = 0.5 * (a.y + b.y);

        // default monochrome (HSL gray)
        let setColor = false;

        // 1) ripple tint (takes precedence)
        for (let r = 0; r < this.ripples.length; r++) {
          const rp = this.ripples[r];
          const age = Math.max(0, nowSec - rp.t0);
          const radius = age * this.RIPPLE_SPEED;
          const dist = Math.hypot(mx - rp.x, my - rp.y);
          if (Math.abs(dist - radius) <= this.RIPPLE_WIDTH) {
            p.stroke(rp.hue, 80, 60, Math.min(255, 255 * this.RIPPLE_FADE));
            setColor = true;
            break;
          }
        }

        // 2) noise-driven palette (random subset), modulated by joystick
        if (!setColor) {
          const n = p.noise(mx * this.colorNoiseScale, my * this.colorNoiseScale, this._t * 0.8);
          if (n < coloredFrac) {
            // map n to a hue span around the joystick-chosen center
            const h = hueCenter + (n - 0.5) * 2 * hueWidth; // center ±width
            const sat = 75 + Math.min(20, 25 * this._joyMag); // a bit more vivid with mag
            const lit = 55 + 10 * (1 - t); // closer lines a touch brighter
            p.stroke((h + 360) % 360, sat, lit, this.colorAlpha);
            setColor = true;
          }
        }

        if (!setColor) {
          // clean gray default (≈ rgb 230)
          p.stroke(0, 0, 90, 160);
        }

        p.strokeWeight(w);
        p.line(a.x, a.y, b.x, b.y);
      }
    }

    p.pop();

    // Cull old ripples once their radius exceeds screen diagonal
    const maxR = Math.hypot(p.width, p.height);
    this.ripples = this.ripples.filter(rp => (nowSec - rp.t0) * this.RIPPLE_SPEED < maxR + 200);
  }
}

export default VideoConnectedParticlesEffect;
