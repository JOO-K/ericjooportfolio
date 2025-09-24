// videothreshold.js — solid white threshold grid (raindrops + stroke length by joystick)
// + OPTIONAL (only while joystick active): shape morph (line→cross→diamond→dot) + light color bloom
//
// Hover: attract crosses toward the pointer.
// Click/tap: strong "bullet-hole" (explosive kick + shove) that grows/holds/heals.
// Joystick:
//   - Y axis = RAINDROPS
//       * y > 0  => larger holes, lower frequency (heavy drops)
//       * y < 0  => smaller holes, higher frequency (drizzle)
//       * |y|    => intensity (both radius & rate scale with magnitude)
//   - X axis = STROKE LENGTH scale (left = shorter, right = longer)
//       * while joystick is active, also morphs shape (line→cross→diamond→dot)
//
// Draws full grid every frame with solid stroke when idle (performance-friendly).

import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';

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

    // ===== Bullet-hole ripple timing (finite: grow → hold → decay) =====
    this.HOLE_RADIUS_BASE = 150; // default radius (click)
    this.GROW_TIME   = 0.10;     // faster pop
    this.HOLD_TIME   = 0.25;
    this.DECAY_TIME  = 0.60;

    // edge & inside behaviors — strong
    this.EDGE_BAND     = 28;     // px — shove band while growing
    this.EDGE_PUSH     = 9000;
    this.INSIDE_PUSH   = 14000;

    // extra instantaneous explosive kick early in the event
    this.IMPACT_WINDOW = 0.085;  // s, during which we inject velocity
    this.IMPULSE_VEL   = 2200;   // px/s at unit depth (inside) — added to vx,vy

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

    // ===== Joystick-driven parameters =====
    this._jx = 0;           // last joystick X
    this._jy = 0;           // last joystick Y
    this._jmag = 0;         // last joystick magnitude 0..1
    this._jactive = false;  // last "active" flag (from UI) or inferred by mag

    // Raindrops
    this.dropRateHz   = 0;  // 0..~20 Hz (slightly higher than before)
    this.dropClockSec = 0;  // accumulator
    this.dropRadius   = this.HOLE_RADIUS_BASE;

    // Stroke length scaling (cross arm length)
    this.strokeLenScale = 1.0; // 0.5..1.9 typically

    // Shape morph phase (only used while joystick active)
    this._shapePhase = 0;

    // Lightweight color settings (only used while joystick active)
    this._hueBase = 210;     // center hue
    this._hueSpan = 50;      // ± span
    this._bloom = 0.6;       // 0..1 bloom mix
    this._joyActiveEps = 0.12;
  }

  // Joystick mapping:
  //  Y>0  => THICC low-rate rain (big holes, slow cadence)
  //  Y<0  => DRIZZLE high-rate rain (small holes, fast cadence)
  //  |Y|  => intensity
  //  X    => stroke length scale (left shorter, right longer) + (when active) shape morph
  onJoystick({ x = 0, y = 0, mag = 0, active = false } = {}) {
    this._jx = x;
    this._jy = y;
    this._jmag = Math.max(0, Math.min(1, mag || 0));
    this._jactive = !!active || this._jmag > this._joyActiveEps;

    const magY = Math.min(1, Math.max(0, Math.abs(y)));

    // Frequency — slightly higher overall; drizzle fastest
    const MAX_HZ = 20;                  // was 15
    const baseHz = MAX_HZ * magY;
    this.dropRateHz = y >= 0 ? baseHz * 0.45 : baseHz * 1.20; // heavy slower, drizzle faster

    // Radius — smaller overall; drizzle gets smaller minimum
    const R_SMALL = 40;   // was 70
    const R_LARGE = 240;
    this.dropRadius = y >= 0
      ? lerp(this.HOLE_RADIUS_BASE, R_LARGE, magY)   // y up → bigger (but same max as before)
      : lerp(R_SMALL, this.HOLE_RADIUS_BASE, magY);  // y down → smaller

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

  // spawn helpers
  _spawnRipple(x, y, tSec, radius) {
    this.ripples.push({ x, y, t0: tSec, radius: radius ?? this.HOLE_RADIUS_BASE });
    if (this.ripples.length > this.MAX_RIPPLES) this.ripples.shift();
  }

  update(p, dtMs) {
    this._dt = Math.max(0.001, Math.min(0.033, (dtMs || 16.7) / 1000));
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;

    p.background(CONFIG.BG_COLOR);

    // prune finished ripples
    const now = p.millis() * 0.001;
    this.ripples = this.ripples.filter(rp => this._rippleRadius(now, rp) >= 0);

    // ===== Joystick procedural "raindrops" =====
    // Only actually spawn if joystick Y is contributing some rate (same as before).
    if (this.dropRateHz > 0.001) {
      this.dropClockSec += this._dt;
      const period = 1 / this.dropRateHz;

      const dropsPerTickBase = 1 + Math.floor(Math.min(1, Math.abs(this._jy)) * 3); // 1..4
      while (this.dropClockSec >= period) {
        this.dropClockSec -= period;

        const dropsThisTick = dropsPerTickBase;
        for (let h = 0; h < dropsThisTick; h++) {
          let x, y;
          const rad = this.dropRadius * (0.85 + Math.random() * 0.3); // slight variance
          if (this.pointerX >= 0 && this.pointerY >= 0) {
            // jitter around the cursor for painterly control
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

    const cell = this.cell, cols = this.cols, rows = this.rows, dt = this._dt;
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

        // ===== bullet-hole ripples (strong) =====
        // Also compute a small "influence" for optional color bloom (only used when active)
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
                colorInfluence = Math.max(colorInfluence, u * 0.6);
                const mag = this.EDGE_PUSH * (0.9 + 0.2 * Math.random()) * u;
                fx += (dx / d) * mag;
                fy += (dy / d) * mag;
              }
            }
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

        // --- appearance --------------------------------------

        // stroke weight by darkness
        const br = this._brightnessAt(cx, cy, p);
        const darkness = 1 - Math.min(Math.max(br / 255, 0), 1);
        const w = this.strokeMin + darkness * (this.strokeMax - this.strokeMin);
        const sizePx = Math.max(this.sizeMin, darkness * (cell * this.sizeMax));

        const angle = tSec * 0.7 + gx * 0.05 - gy * 0.04;
        const lenScale = this.strokeLenScale; // 0.55..1.9
        const rlen = sizePx * 0.5 * lenScale;

        // IDLE (fast path): pure white rotating cross, exactly like your original
        if (!this._jactive) {
          p.stroke(this.strokeColor);
          p.strokeWeight(w);
          p.push();
          p.translate(cx + ox, cy + oy);
          p.rotate(angle);
          p.line(-rlen, 0, rlen, 0);
          p.line(0, -rlen, 0, rlen);
          p.pop();
          continue;
        }

        // ACTIVE (joystick engaged): lightweight color + shape morph
        // Color: cheap HSL sine (no noise), with subtle bloom from nearby impacts
        const hueCenter = this._hueBase;
        const hue = (hueCenter + this._hueSpan * Math.sin(0.5 * tSec + 0.08 * gx - 0.07 * gy) 
                     + this._hueSpan * this._bloom * colorInfluence) % 360;
        const sat = 54 + Math.floor(28 * Math.min(1, colorInfluence * 1.2));
        const lit = 62 + Math.floor(12 * Math.min(1, colorInfluence));
        p.stroke(`hsl(${(hue+360)%360}, ${sat}%, ${lit}%)`);
        p.strokeWeight(w);

        // Morph: map |X|∈[0,1] → 3 stages (0..1..2..3)
        const shapePhase = this._shapePhase * 3.0; // 0..3
        const stage = Math.floor(shapePhase);      // 0,1,2
        const localT = Math.max(0, Math.min(1, shapePhase - stage)); // 0..1

        p.push();
        p.translate(cx + ox, cy + oy);
        p.rotate(angle);

        if (stage === 0) {
          // line → cross
          drawLine(p, rlen);
          if (localT > 0) {
            p.push();
            p.drawingContext.globalAlpha = localT;
            drawCross(p, rlen);
            p.pop();
          }
        } else if (stage === 1) {
          // cross → diamond
          p.push(); p.drawingContext.globalAlpha = 1 - localT; drawCross(p, rlen);   p.pop();
          p.push(); p.drawingContext.globalAlpha = localT;     drawDiamond(p, rlen); p.pop();
        } else {
          // diamond → dot
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
function drawLine(p, len) {
  // single horizontal line (we're already rotated)
  p.line(-len, 0, len, 0);
}
function drawCross(p, len) {
  p.line(-len, 0, len, 0);
  p.line(0, -len, 0, len);
}
function drawDiamond(p, len) {
  p.beginShape();
  p.vertex(0, -len);
  p.vertex(len, 0);
  p.vertex(0, len);
  p.vertex(-len, 0);
  p.endShape(p.CLOSE);
}
function drawDot(p, r) {
  p.circle(0, 0, Math.max(2, r) * 2);
}

/* ===== tiny helpers ===== */
function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }
