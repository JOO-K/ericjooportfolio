// videoflock.js — "Gallery Visitors": slow agents inside the video silhouette with a 2.5D look.
// Agents wander between "artworks" (POIs) inside the silhouette, pause to look, avoid each other,
// and are rendered with perspective scaling + soft shadows.

import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';

/* ------------------ Mask helpers ------------------ */
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
function gradient(maskData, w, h, x, y, step = 3) {
  const bL = brightnessAt(maskData, w, h, x - step, y);
  const bR = brightnessAt(maskData, w, h, x + step, y);
  const bU = brightnessAt(maskData, w, h, x, y - step);
  const bD = brightnessAt(maskData, w, h, x, y + step);
  return { x: -(bR - bL) / (2 * step), y: -(bD - bU) / (2 * step) }; // inward = -∇b
}
function projectInside(maskData, w, h, x, y, tries = 12, step = 4) {
  let px = x, py = y;
  for (let i = 0; i < tries; i++) {
    if (isInside(maskData, w, h, px, py)) return { x: px, y: py, ok: true };
    const g = gradient(maskData, w, h, px, py, step);
    const mag = Math.hypot(g.x, g.y) || 1;
    const alpha = 1 - i / tries;
    const s = step * (1.5 + 0.5 * alpha);
    px += (g.x / mag) * s;
    py += (g.y / mag) * s;
  }
  return { x: px, y: py, ok: isInside(maskData, w, h, px, py) };
}
function findRandomInside(maskData, w, h, attempts = 800) {
  for (let i = 0; i < attempts; i++) {
    const x = Math.random() * w, y = Math.random() * h;
    if (isInside(maskData, w, h, x, y)) return { x, y, ok: true };
  }
  return { x: w * 0.5, y: h * 0.5, ok: false };
}

/* ------------------ Agent (gallery visitor) ------------------ */
class Agent {
  constructor(x, y, maxSpeed, maxForce) {
    this.pos = { x, y };
    this.vel = { x: 0, y: 0 };
    this.acc = { x: 0, y: 0 };
    this.prevAcc = { x: 0, y: 0 };

    this.maxSpeed = maxSpeed;  // px/s
    this.maxForce = maxForce;  // steering accel

    // state machine: 'walk' or 'look'
    this.state = 'walk';
    this.stateUntil = 0;       // millis deadline

    // target (artwork/POI)
    this.target = { x, y };

    // personal space radius for separation
    this.spaceR = 22;

    // slight personality
    this.noisePhase = Math.random() * 1000;
    this.speedJitter = 0.75 + Math.random() * 0.5;
  }

  setTarget(x, y) { this.target = { x, y }; }

  applyForce(fx, fy) { this.acc.x += fx; this.acc.y += fy; }

  // choose next dwell duration
  schedule(p, ms) { this.stateUntil = p.millis() + ms; }

  // behaviors
  separation(neighbors) {
    let steer = { x: 0, y: 0 }, count = 0;
    const r2 = this.spaceR * this.spaceR;
    for (const a of neighbors) {
      if (a === this) continue;
      const dx = a.pos.x - this.pos.x, dy = a.pos.y - this.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1e-6 && d2 < r2) {
        const inv = 1 / Math.sqrt(d2);
        const w = 1 / (d2 + 1);
        steer.x -= dx * inv * w;
        steer.y -= dy * inv * w;
        count++;
      }
    }
    if (!count) return;
    const m = Math.hypot(steer.x, steer.y) || 1;
    this.applyForce((steer.x / m) * this.maxForce * 0.9, (steer.y / m) * this.maxForce * 0.9);
  }

  lightAlignment(neighbors) {
    let sum = { x: 0, y: 0 }, count = 0;
    const R = 80, R2 = R * R;
    for (const a of neighbors) {
      if (a === this) continue;
      const dx = a.pos.x - this.pos.x, dy = a.pos.y - this.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < R2) { sum.x += a.vel.x; sum.y += a.vel.y; count++; }
    }
    if (!count) return;
    sum.x /= count; sum.y /= count;
    const len = Math.hypot(sum.x, sum.y) || 1;
    const desired = { x: (sum.x / len) * this.maxSpeed, y: (sum.y / len) * this.maxSpeed };
    const steer = { x: desired.x - this.vel.x, y: desired.y - this.vel.y };
    const mag = Math.hypot(steer.x, steer.y) || 1;
    const m = Math.min(this.maxForce * 0.35, mag);
    this.applyForce((steer.x / mag) * m, (steer.y / mag) * m);
  }

  // slow seek to target with gentle arrival
  seekTarget() {
    const dx = this.target.x - this.pos.x, dy = this.target.y - this.pos.y;
    const dist = Math.hypot(dx, dy) || 1;
    const arriveR = 120;
    // slow down when close
    const speed = (dist < arriveR) ? this.maxSpeed * (dist / arriveR) : this.maxSpeed;
    const desired = { x: (dx / dist) * speed * this.speedJitter, y: (dy / dist) * speed * this.speedJitter };
    const steer = { x: desired.x - this.vel.x, y: desired.y - this.vel.y };
    const mag = Math.hypot(steer.x, steer.y) || 1;
    const m = Math.min(this.maxForce * 0.75, mag);
    this.applyForce((steer.x / mag) * m, (steer.y / mag) * m);
  }

  // very light wander so they feel alive when looking
  idleWander(p, gain = 18, scale = 0.0016, t = 0) {
    const n = p.noise(this.pos.x * scale, this.pos.y * scale, t + this.noisePhase);
    const a = (n - 0.5) * Math.PI * 0.65;
    this.applyForce(Math.cos(a) * gain, Math.sin(a) * gain);
  }

  keepInBounds(w, h, pad = 16, force = 0.25) {
    if (this.pos.x < pad)       this.applyForce( force, 0);
    else if (this.pos.x > w-pad) this.applyForce(-force, 0);
    if (this.pos.y < pad)       this.applyForce(0,  force);
    else if (this.pos.y > h-pad) this.applyForce(0, -force);
  }

  integrate(dt, smooth = 0.72) {
    // accel smoothing (low-pass)
    this.acc.x = this.acc.x * smooth + this.prevAcc.x * (1 - smooth);
    this.acc.y = this.acc.y * smooth + this.prevAcc.y * (1 - smooth);

    this.vel.x += this.acc.x; this.vel.y += this.acc.y;

    const sp = Math.hypot(this.vel.x, this.vel.y) || 1;
    if (sp > this.maxSpeed) {
      const k = this.maxSpeed / sp;
      this.vel.x *= k; this.vel.y *= k;
    }

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    this.prevAcc.x = this.acc.x; this.prevAcc.y = this.acc.y;
    this.acc.x = 0; this.acc.y = 0;
  }

  draw2p5d(p, color, yMax) {
    // perspective scale: higher y → closer → larger
    const depth = Math.min(1, Math.max(0, this.pos.y / (yMax || p.height)));
    const s = 0.75 + depth * 0.7; // 0.75..1.45 scale
    const bodyH = 10 * s;
    const bodyW = 6 * s;
    const headR = 3.2 * s;

    // soft shadow on "floor"
    p.noStroke();
    p.fill(0, 0, 0, 70);
    p.ellipse(this.pos.x + 0, this.pos.y + 4 * s, bodyW * 1.6, bodyW * 0.8);

    // body (capsule) + head
    p.fill(color);
    p.rectMode(p.CENTER);
    p.rect(this.pos.x, this.pos.y, bodyW, bodyH, bodyW * 0.5);
    p.circle(this.pos.x, this.pos.y - bodyH * 0.55, headR);
  }
}

/* ------------------ Effect ------------------ */
export class VideoFlockingEffect {
  constructor() {
    this.name = 'Video Gallery Visitors (2.5D inside silhouette)';

    // video/mask
    this.video = null;
    this.maskData = null;

    // agents (slow)
    this.NUM_AGENTS_DESKTOP = 120;
    this.NUM_AGENTS_MOBILE  = 70;
    this.MAX_SPEED = 60;     // px/s (slow walk)
    this.MAX_FORCE = 55;     // gentle steering

    // silhouette guidance
    this.FIELD_STEP   = 4;
    this.FIELD_PULL   = 0.28; // inward pull to stay inside
    this.BOUND_PUSH   = 0.9;  // stronger at edges
    this.PROJECT_TRIES= 14;
    this.PROJECT_STEP = 3;

    // POIs ("artworks") sampled inside silhouette
    this.POI_GRID     = 12;    // sample grid size (higher = denser sampling)
    this.MAX_POI      = 26;    // max artworks
    this.POI_JITTER   = 16;    // random offset (px)
    this.POIS = [];

    // dwell timings (ms)
    this.LOOK_MIN = 1400;
    this.LOOK_MAX = 2800;
    this.WALK_MIN = 2500;
    this.WALK_MAX = 5200;

    // wander timebase
    this._nt = 0;
    this.WANDER_TIME = 0.12;

    // color
    this.AGENT_COLOR = 235;

    this.agents = [];
  }

  preload(p) {}

  setup(p) {
    const isMobile = p.windowWidth <= 800;
    this.video = new VideoPlaylist({ isMobile });
    this.video.init(p.width, p.height);

    // Seed temporarily anywhere — once mask arrives, we’ll constrain & retarget
    this._seedAgents(p, false);
  }

  dispose() { this.video?.dispose?.(); }

  resize(p) {
    this.video?.resize(p.width, p.height);
    // Rebuild POIs when size changes
    this._buildPOIs(p);
    // Re-seed agents inside if we have a mask; else keep and they’ll be pulled in
    this._seedAgents(p, true);
  }

  _seedAgents(p, maskAware) {
    const count = (p.windowWidth <= 800) ? this.NUM_AGENTS_MOBILE : this.NUM_AGENTS_DESKTOP;
    const md = this.maskData;
    this.agents = [];
    for (let i = 0; i < count; i++) {
      let x, y;
      if (maskAware && md) {
        const spot = findRandomInside(md, p.width, p.height, 1000);
        x = spot.x; y = spot.y;
      } else {
        x = Math.random() * p.width; y = Math.random() * p.height;
      }
      const a = new Agent(x, y, this.MAX_SPEED, this.MAX_FORCE);
      a.state = 'walk';
      a.stateUntil = 0;
      this.agents.push(a);
    }
  }

  _buildPOIs(p) {
    this.POIS = [];
    const md = this.maskData;
    if (!md) return;

    const cols = this.POI_GRID, rows = this.POI_GRID;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const x = (i / (cols + 1)) * p.width;
        const y = (j / (rows + 1)) * p.height;
        if (isInside(md, p.width, p.height, x, y)) {
          // jitter to avoid perfect grid
          const jx = (Math.random() - 0.5) * this.POI_JITTER;
          const jy = (Math.random() - 0.5) * this.POI_JITTER;
          this.POIS.push({ x: x + jx, y: y + jy });
        }
      }
    }
    // trim to max
    if (this.POIS.length > this.MAX_POI) {
      // pick evenly
      const step = Math.max(1, Math.floor(this.POIS.length / this.MAX_POI));
      this.POIS = this.POIS.filter((_, idx) => idx % step === 0).slice(0, this.MAX_POI);
    }
    // ensure at least a handful
    if (this.POIS.length < 6) {
      // sprinkle random inside points
      for (let k = 0; k < 10; k++) {
        const sp = findRandomInside(md, p.width, p.height, 1000);
        this.POIS.push({ x: sp.x, y: sp.y });
      }
    }
  }

  _chooseNextPOI(p, from) {
    if (!this.POIS.length) return from;
    // prefer a different POI at medium distance
    const candidates = this.POIS
      .map(pt => ({ pt, d: Math.hypot(pt.x - from.x, pt.y - from.y) }))
      .filter(o => o.d > 80); // avoid tiny hops
    if (!candidates.length) return this.POIS[Math.floor(Math.random() * this.POIS.length)];
    // pick one in the middle distance range
    candidates.sort((a, b) => a.d - b.d);
    const midStart = Math.floor(candidates.length * 0.35);
    const midEnd   = Math.floor(candidates.length * 0.8);
    const idx = Math.floor(Math.random() * Math.max(1, (midEnd - midStart))) + midStart;
    return candidates[Math.min(idx, candidates.length - 1)].pt;
  }

  update(p, dtMs) {
    const dt = Math.max(0.001, Math.min(0.033, (dtMs || 16.7) / 1000));
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;
    p.background(CONFIG.BG_COLOR);

    // Build POIs once the mask is available
    if (!this._poisReady && this.maskData) {
      this._buildPOIs(p);
      // move any outsiders inside & retarget
      for (const a of this.agents) {
        if (!isInside(this.maskData, p.width, p.height, a.pos.x, a.pos.y)) {
          const loc = findRandomInside(this.maskData, p.width, p.height, 1000);
          a.pos.x = loc.x; a.pos.y = loc.y;
        }
        a.setTarget(this._chooseNextPOI(p, a.pos));
        a.schedule(p, this._rand(this.WALK_MIN, this.WALK_MAX));
      }
      this._poisReady = true;
    }

    // Advance wander time
    this._nt += dt * this.WANDER_TIME;

    const agents = this.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];

      // state transitions
      if (p.millis() > a.stateUntil) {
        if (a.state === 'walk') {
          // arrived? switch to look
          a.state = 'look';
          a.schedule(p, this._rand(this.LOOK_MIN, this.LOOK_MAX));
          // small velocity damp when starting to look
          a.vel.x *= 0.5; a.vel.y *= 0.5;
        } else {
          // from look → choose a new POI and walk
          a.state = 'walk';
          const next = this._chooseNextPOI(p, a.pos);
          a.setTarget(next);
          a.schedule(p, this._rand(this.WALK_MIN, this.WALK_MAX));
        }
      }

      // social forces
      a.separation(agents);
      a.lightAlignment(agents);

      // task behavior
      if (a.state === 'walk') {
        a.seekTarget();
      } else {
        // looking: barely wander in place (life)
        a.idleWander(p, 12, 0.0018, this._nt);
      }

      // silhouette pull & bounds
      if (this.maskData) {
        const g = gradient(this.maskData, p.width, p.height, a.pos.x, a.pos.y, this.FIELD_STEP);
        const gmag = Math.hypot(g.x, g.y) || 1;
        // keep inside with a subtle, constant inward pull
        a.applyForce((g.x / gmag) * this.MAX_FORCE * this.FIELD_PULL,
                     (g.y / gmag) * this.MAX_FORCE * this.FIELD_PULL);

        // if outside, push harder and damp outward velocity
        if (!isInside(this.maskData, p.width, p.height, a.pos.x, a.pos.y)) {
          a.applyForce((g.x / gmag) * this.MAX_FORCE * this.BOUND_PUSH,
                       (g.y / gmag) * this.MAX_FORCE * this.BOUND_PUSH);
          const vdotOut = a.vel.x * (-g.x) + a.vel.y * (-g.y);
          if (vdotOut > 0) { a.vel.x *= 0.85; a.vel.y *= 0.85; }
        }
      }

      // soft screen bounds
      a.keepInBounds(p.width, p.height, 14, 0.22);

      // integrate
      a.integrate(dt, 0.78);

      // hard constraint inside
      if (this.maskData && !isInside(this.maskData, p.width, p.height, a.pos.x, a.pos.y)) {
        const proj = projectInside(this.maskData, p.width, p.height, a.pos.x, a.pos.y, this.PROJECT_TRIES, this.PROJECT_STEP);
        if (proj.ok) { a.pos.x = proj.x; a.pos.y = proj.y; }
        else {
          const spot = findRandomInside(this.maskData, p.width, p.height, 1000);
          a.pos.x = spot.x; a.pos.y = spot.y;
          a.vel.x *= 0.2; a.vel.y *= 0.2;
        }
      }
    }
  }

  draw(p) {
    // Sorted draw by y for a tiny bit of depth overlap
    const arr = this.agents.slice().sort((A, B) => A.pos.y - B.pos.y);
    for (const a of arr) a.draw2p5d(p, this.AGENT_COLOR, p.height);
  }

  _rand(min, max) { return min + Math.random() * (max - min); }
}

export default VideoFlockingEffect;
