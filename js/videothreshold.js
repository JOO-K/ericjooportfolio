// videothreshold.js — solid white threshold grid (amped impacts + wild joystick)
// Hover: attract crosses toward the pointer.
// Click/tap: ultra-strong "bullet-hole" (explosive kick + shove) that grows/holds/heals.
// Joystick:
//   - Y: spawns holes procedurally (rate & radius by |Y|, 0..12 Hz, 1–4 holes/tick, cursor-biased).
//   - X: spawns knife cuts (rate by |X| up to 8 Hz, 1–3 cuts/tick, angle ±80°, thick band, hard push).
// Draws full grid every frame with solid stroke.

import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';

export default class VideoThresholdEffect {
  constructor(opts = {}) {
    this.name = 'Video Threshold Grid (amped holes + knife cuts)';

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
    this.strokeColor = 255;   // pure white

    // hover attraction
    this.pointerX = -1;
    this.pointerY = -1;
    this.hoverRadius = 140;   // px
    this.hoverPull   = 1200;  // force

    // ===== Bullet-hole ripple timing (finite: grow → hold → decay) =====
    this.HOLE_RADIUS_BASE = 150; // base radius (click)
    this.GROW_TIME   = 0.10;     // faster pop
    this.HOLD_TIME   = 0.25;
    this.DECAY_TIME  = 0.60;

    // edge & inside behaviors — **amped**
    this.EDGE_BAND     = 28;     // px — shove band while growing
    this.EDGE_PUSH     = 9000;   // ↑ MUCH stronger edge shove
    this.INSIDE_PUSH   = 14000;  // ↑ MUCH stronger inside shove

    // extra **instantaneous explosive kick** early in the event
    this.IMPACT_WINDOW = 0.085;  // s, during which we inject velocity
    this.IMPULSE_VEL   = 2200;   // px/s at unit depth (inside) — added to vx,vy

    this.MAX_RIPPLES = 14;
    this.ripples = [];           // { x, y, t0, radius? }

    // ===== Knife cuts (finite) =====
    this.cuts = [];              // { x0, y0, angle, t0 }
    this.CUT_GROW  = 0.07;
    this.CUT_HOLD  = 0.20;
    this.CUT_DECAY = 0.55;
    this.CUT_BAND_BASE = 44;     // half-width px at low intensity
    this.CUT_PUSH      = 11000;  // stronger separation
    this.MAX_CUTS      = 14;

    // springs to center
    this.springK = 40;
    this.damping = 6;

    // per-cell state
    this.cols = 0; this.rows = 0; this.cell = 24;
    this.state = null;           // Float32Array [ox,oy,vx,vy]*

    this._dt = 1/60;
    this._canvas = null;

    // ===== Joystick-driven procedural spawning =====
    this._jx = 0;           // last joystick X
    this._jy = 0;           // last joystick Y
    this.holeRateHz = 0;    // 0..~12 Hz
    this.cutRateHz  = 0;    // 0..~8 Hz
    this.holeClock  = 0;    // sec accumulator
    this.cutClock   = 0;    // sec accumulator
  }

  // Joystick: map axes to procedural spawners
  //  - |Y| → holes (0..12 Hz), radius scales with |Y|
  //  - |X| → cuts  (0..8 Hz),  band & angle scale with X (±80°)
  onJoystick({ x = 0, y = 0 } = {}) {
    const ease = (v) => Math.pow(Math.min(1, Math.max(0, Math.abs(v))), 0.85);

    this._jx = x;
    this._jy = y;

    this.holeRateHz = 12 * ease(y);  // go wild
    this.cutRateHz  =  8 * ease(x);
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

  // finite ripple radius profile: grow → hold → decay
  _rippleRadius(now, rp) {
    const age = Math.max(0, now - rp.t0);
    if (age < this.GROW_TIME) {
      const t = this._smoothstep(age / this.GROW_TIME);
      return rp.radius * t;
    }
    if (age < this.GROW_TIME + this.HOLD_TIME) {
      return rp.radius;
    }
    const d = age - (this.GROW_TIME + this.HOLD_TIME);
    if (d < this.DECAY_TIME) {
      const t = 1 - this._smoothstep(d / this.DECAY_TIME);
      return rp.radius * t;
    }
    return -1; // finished
  }

  // finite cut profile: grow → hold → decay; returns band half-width (otherwise <0 done)
  _cutBand(now, cut) {
    const age = Math.max(0, now - cut.t0);
    if (age < this.CUT_GROW) {
      const t = this._smoothstep(age / this.CUT_GROW);
      return cut.band * (0.35 + 0.65 * t);
    }
    if (age < this.CUT_GROW + this.CUT_HOLD) {
      return cut.band;
    }
    const d = age - (this.CUT_GROW + this.CUT_HOLD);
    if (d < this.CUT_DECAY) {
      const t = 1 - this._smoothstep(d / this.CUT_DECAY);
      return cut.band * (0.35 + 0.65 * t);
    }
    return -1;
  }

  // spawn helpers
  _spawnRipple(x, y, tSec, radius) {
    this.ripples.push({ x, y, t0: tSec, radius: radius ?? this.HOLE_RADIUS_BASE });
    if (this.ripples.length > this.MAX_RIPPLES) this.ripples.shift();
  }
  _spawnCut(p, angleRad, tSec, bandPx) {
    // center along perpendicular spacing with jitter
    const cx = p.width * 0.5;
    const cy = p.height * 0.5;
    const span = (p.width + p.height) * 0.50;
    const jitter = (Math.random() - 0.5) * span;
    const nx = Math.cos(angleRad + Math.PI * 0.5);
    const ny = Math.sin(angleRad + Math.PI * 0.5);
    const x0 = cx + nx * jitter;
    const y0 = cy + ny * jitter;

    this.cuts.push({ x0, y0, angle: angleRad, t0: tSec, band: bandPx ?? this.CUT_BAND_BASE });
    if (this.cuts.length > this.MAX_CUTS) this.cuts.shift();
  }

  update(p, dtMs) {
    this._dt = Math.max(0.001, Math.min(0.033, (dtMs || 16.7) / 1000));
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;

    p.background(CONFIG.BG_COLOR);

    // prune finished ripples / cuts
    const now = p.millis() * 0.001;
    this.ripples = this.ripples.filter(rp => this._rippleRadius(now, rp) >= 0);
    this.cuts    = this.cuts.filter(ct => this._cutBand(now, ct) >= 0);

    // ===== Joystick procedural spawning =====
    const dtSec = this._dt;

    // Holes: bias near pointer if present, else random
    if (this.holeRateHz > 0.001) {
      this.holeClock += dtSec;
      const period = 1 / this.holeRateHz;
      while (this.holeClock >= period) {
        this.holeClock -= period;

        const ay = Math.min(1, Math.max(0, Math.abs(this._jy)));
        const holesPerTick = 1 + Math.floor(ay * 3); // 1..4
        const rad = this.HOLE_RADIUS_BASE * (0.70 + 0.90 * ay);

        for (let h = 0; h < holesPerTick; h++) {
          let x, y;
          if (this.pointerX >= 0 && this.pointerY >= 0) {
            // jitter around the cursor for painterly control
            const jitterR = rad * 0.7 * (Math.random() * 0.6);
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
      this.holeClock = 0;
    }

    // Cuts: angle by X (±80°), band grows with |X|, multiple cuts per tick
    if (this.cutRateHz > 0.001) {
      this.cutClock += dtSec;
      const period = 1 / this.cutRateHz;
      while (this.cutClock >= period) {
        this.cutClock -= period;

        const ax = Math.min(1, Math.max(0, Math.abs(this._jx)));
        const maxRad = (80 * Math.PI) / 180;
        const angle = this._jx * maxRad;
        const band = this.CUT_BAND_BASE * (0.9 + 2.2 * ax); // wider with X
        const cutsPerTick = 1 + Math.floor(ax * 2); // 1..3

        for (let c = 0; c < cutsPerTick; c++) {
          // tiny angle jitter so multiple cuts don't overlap perfectly
          const jitter = (Math.random() - 0.5) * (8 * Math.PI / 180);
          this._spawnCut(p, angle + jitter, now, band);
        }
      }
    } else {
      this.cutClock = 0;
    }
  }

  draw(p) {
    if (!this.maskData) return;

    const cell = this.cell, cols = this.cols, rows = this.rows, dt = this._dt;
    const tSec = p.millis() * 0.001;

    const phase = this.phaseTick % this.PHASES; this.phaseTick++;

    p.push();
    p.noFill();
    p.stroke(this.strokeColor); // solid white

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (((gx + gy) % this.PHASES) !== phase) continue;

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

        // ===== bullet-hole ripples (amped) =====
        for (let r = 0; r < this.ripples.length; r++) {
          const rp = this.ripples[r];
          const rad = this._rippleRadius(now, rp);
          if (rad < 0) continue;

          const dx = (cx + ox) - rp.x;
          const dy = (cy + oy) - rp.y;
          const d  = Math.hypot(dx, dy) || 1e-6;

          if (d < rad) {
            const depth = (rad - d) / Math.max(rad, 1);
            const mag = this.INSIDE_PUSH * (0.85 + 0.30 * Math.random()) * depth;
            fx += (dx / d) * mag;
            fy += (dy / d) * mag;

            // explosive *velocity* kick for the first ~IMPACT_WINDOW seconds
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
                const mag = this.EDGE_PUSH * (0.9 + 0.2 * Math.random()) * u;
                fx += (dx / d) * mag;
                fy += (dy / d) * mag;
              }
            }
          }
        }

        // ===== knife cuts (thick band, hard push) =====
        for (let k = 0; k < this.cuts.length; k++) {
          const ct = this.cuts[k];
          const band = this._cutBand(now, ct);
          if (band < 0) continue;

          const nx = Math.cos(ct.angle + Math.PI * 0.5);
          const ny = Math.sin(ct.angle + Math.PI * 0.5);

          const dx = (cx + ox) - ct.x0;
          const dy = (cy + oy) - ct.y0;
          const dist = dx * nx + dy * ny; // signed distance to line
          const ad = Math.abs(dist);

          if (ad <= band) {
            const u = 1 - ad / band; // 0..1 center strongest
            const dir = Math.sign(dist) || 1;

            // force apart along normal
            const mag = this.CUT_PUSH * (0.85 + 0.3 * Math.random()) * u;
            fx += nx * mag * dir;
            fy += ny * mag * dir;

            // tiny shear velocity for extra drama
            vx += nx * 300 * dir * u;
            vy += ny * 300 * dir * u;
          }
        }

        // spring to center + damping
        fx += -this.springK * ox - this.damping * vx;
        fy += -this.springK * oy - this.damping * vy;

        // integrate
        vx += fx * dt; vy += fy * dt;
        ox += vx * dt; oy += vy * dt;

        this.state[sIdx    ] = ox;
        this.state[sIdx + 1] = oy;
        this.state[sIdx + 2] = vx;
        this.state[sIdx + 3] = vy;

        // draw cross (solid)
        const br = this._brightnessAt(cx, cy, p);
        const darkness = 1 - Math.min(Math.max(br / 255, 0), 1);
        const w = this.strokeMin + darkness * (this.strokeMax - this.strokeMin);
        const sizePx = Math.max(this.sizeMin, darkness * (cell * this.sizeMax));
        const angle = tSec * 0.7 + gx * 0.05 - gy * 0.04;

        p.strokeWeight(w);
        p.push();
        p.translate(cx + ox, cy + oy);
        p.rotate(angle);
        const rlen = sizePx * 0.5;
        p.line(-rlen, 0, rlen, 0);
        p.line(0, -rlen, 0, rlen);
        p.pop();
      }
    }
    p.pop();
  }
}

/* ===== tiny helpers ===== */
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
