// videogravity.js — Stars orbiting silhouette with gravitational physics
// Stars are attracted to points within the video silhouette, creating orbital patterns
// Audio-reactive with gentle pulsing and color shifts

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

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* ----------------- effect ----------------- */
export default class VideoGravityEffect {
  constructor(opts = {}) {
    this.name = 'Video Gravity Stars';

    this.video = opts.playlist || null;
    this._ownsVideo = !this.video;
    this.maskData = null;

    // Stars config
    this.NUM_STARS = 800;           // Total stars
    this.STAR_SIZE_MIN = 1.5;
    this.STAR_SIZE_MAX = 3.5;

    // Gravity bodies (points within silhouette)
    this.NUM_GRAVITY_POINTS = 18;   // Fewer points = better performance
    this.GRAVITY_STRENGTH = 120000;  // Attraction force
    this.ORBIT_RADIUS = 60;          // Activation radius for glow
    this.GLOW_RADIUS = 80;           // Glow effect radius

    // Physics
    this.MAX_VELOCITY = 400;
    this.DAMPING = 0.98;
    this.INITIAL_SPREAD = 0.6;       // How spread out stars start

    this.stars = [];
    this.gravityPoints = [];
    this.bgRgb = hexToRgb(CONFIG.BG_COLOR);

    // Audio
    this._kEnv = 0; this._prevK = 0;
    this.K_ATTACK = 1.0; this.K_DECAY = 0.88;
    this._flash = 0; this.FLASH_DECAY = 0.85;

    // Joystick
    this._jx = 0; this._jy = 0; this._jmag = 0;
  }

  onJoystick({ x = 0, y = 0, mag = 0 } = {}) {
    this._jx = clamp(x, -1, 1);
    this._jy = clamp(y, -1, 1);
    this._jmag = clamp(mag, 0, 1);
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

    this._initStars(p);
    this.gravityPoints = []; // Initialize empty, will populate on first update
    p.colorMode(p.RGB, 255, 255, 255, 255);
  }

  dispose() {
    if (this._ownsVideo) this.video?.dispose?.();
  }

  resize(p) {
    this.video?.resize?.(p.width, p.height);
    this._initStars(p);
  }

  _initStars(p) {
    this.stars = [];
    const cx = p.width * 0.5;
    const cy = p.height * 0.5;
    const spread = Math.max(p.width, p.height) * this.INITIAL_SPREAD;

    for (let i = 0; i < this.NUM_STARS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * spread;
      this.stars.push({
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        vx: (Math.random() - 0.5) * 50,
        vy: (Math.random() - 0.5) * 50,
        size: lerp(this.STAR_SIZE_MIN, this.STAR_SIZE_MAX, Math.random()),
        brightness: 0.3 + Math.random() * 0.7,
        hue: Math.random() * 40 - 20 // slight color variation
      });
    }

    this.gravityPoints = [];
  }

  _updateGravityPoints(p) {
    if (!this.maskData) return;

    const desired = this.NUM_GRAVITY_POINTS;
    const step = 25; // sample every N pixels

    // Find points inside silhouette
    const candidates = [];
    for (let y = 0; y < p.height; y += step) {
      for (let x = 0; x < p.width; x += step) {
        if (isInside(this.maskData, p.width, p.height, x, y)) {
          candidates.push({ x, y });
        }
      }
    }

    if (candidates.length === 0) return;

    // Distribute points evenly across silhouette
    this.gravityPoints = [];
    const stride = Math.max(1, Math.floor(candidates.length / desired));
    for (let i = 0; i < candidates.length && this.gravityPoints.length < desired; i += stride) {
      this.gravityPoints.push({
        x: candidates[i].x,
        y: candidates[i].y,
        mass: 1.0,
        activeStars: 0 // count of stars in orbit
      });
    }
  }

  _audio() {
    const b = window.__AUDIO_BUS || {};
    const c = (v) => clamp(v ?? 0, 0, 1);
    return {
      playing: !!b.playing,
      rms: c(b.rms),
      k: c(b.kick),
      bass: c(b.bands?.bass),
      mid: c(b.bands?.mid),
      treble: c(b.bands?.treble)
    };
  }

  update(p, dtMs) {
    const dt = Math.min(dtMs || 16.7, 33.3) / 1000; // cap at ~30fps for stability

    // Audio envelopes
    const A = this._audio();
    const EDGE = 0.55;
    if (A.k > EDGE && this._prevK <= EDGE) {
      this._kEnv = 1.0;
      this._flash = 1.0;
    }
    this._prevK = A.k;
    this._kEnv = Math.max(this._kEnv * this.K_DECAY, A.k * this.K_ATTACK);
    this._flash *= this.FLASH_DECAY;

    // Update mask
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;

    // Update gravity points every few frames (or immediately if none exist)
    if (this.gravityPoints.length === 0 || p.frameCount % 30 === 0) {
      this._updateGravityPoints(p);
    }

    // Reset active star count
    for (const gp of this.gravityPoints) {
      gp.activeStars = 0;
    }

    // Joystick force
    const jForceX = this._jx * this._jmag * 300;
    const jForceY = this._jy * this._jmag * 300;

    // Update each star
    for (const star of this.stars) {
      let fx = jForceX;
      let fy = jForceY;

      // Gravitational attraction to all gravity points
      for (const gp of this.gravityPoints) {
        const dx = gp.x - star.x;
        const dy = gp.y - star.y;
        const distSq = dx * dx + dy * dy + 1; // +1 to avoid divide by zero
        const dist = Math.sqrt(distSq);

        // Gravitational force: F = G * m1 * m2 / r^2
        const force = (this.GRAVITY_STRENGTH * gp.mass) / distSq;
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;

        // Check if star is in orbit (within activation radius)
        if (dist < this.ORBIT_RADIUS) {
          gp.activeStars++;
        }
      }

      // Update velocity
      star.vx += fx * dt;
      star.vy += fy * dt;

      // Damping
      star.vx *= this.DAMPING;
      star.vy *= this.DAMPING;

      // Clamp velocity
      const speed = Math.sqrt(star.vx * star.vx + star.vy * star.vy);
      if (speed > this.MAX_VELOCITY) {
        star.vx = (star.vx / speed) * this.MAX_VELOCITY;
        star.vy = (star.vy / speed) * this.MAX_VELOCITY;
      }

      // Update position
      star.x += star.vx * dt;
      star.y += star.vy * dt;

      // Wrap around screen edges
      if (star.x < 0) star.x = p.width;
      if (star.x > p.width) star.x = 0;
      if (star.y < 0) star.y = p.height;
      if (star.y > p.height) star.y = 0;
    }
  }

  draw(p) {
    const A = this._audio();

    // Background
    p.background(this.bgRgb.r, this.bgRgb.g, this.bgRgb.b);

    // Skip drawing if no gravity points yet
    if (this.gravityPoints.length === 0 || this.stars.length === 0) return;

    // Audio-reactive color shifts
    const baseHue = 210; // blue
    const hueShift = A.bass * 30 + this._kEnv * 20;
    const energy = clamp(A.rms + A.bass * 0.5 + this._kEnv * 0.3, 0, 1);

    // Draw glow halos around active gravity points
    p.push();
    p.colorMode(p.HSL, 360, 100, 100, 255);
    p.noStroke();

    for (const gp of this.gravityPoints) {
      if (gp.activeStars > 0) {
        const intensity = Math.min(1, gp.activeStars / 8);
        const glowSize = this.GLOW_RADIUS * (0.6 + intensity * 0.4);
        const alpha = Math.round(intensity * (120 + this._flash * 80));

        const hue = (baseHue + hueShift) % 360;
        p.fill(hue, 70, 65, alpha);
        p.circle(gp.x, gp.y, glowSize * 2);

        // Inner bright core
        p.fill(hue, 50, 80, alpha * 1.5);
        p.circle(gp.x, gp.y, glowSize * 0.6);
      }
    }
    p.pop();

    // Draw stars
    p.push();
    p.colorMode(p.HSL, 360, 100, 100, 255);
    p.noStroke();

    for (const star of this.stars) {
      // Check distance to nearest gravity point for color
      let minDist = Infinity;
      for (const gp of this.gravityPoints) {
        const dx = gp.x - star.x;
        const dy = gp.y - star.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist) minDist = dist;
      }

      // Color based on proximity to gravity wells
      const proximity = clamp(1 - minDist / this.ORBIT_RADIUS, 0, 1);
      const hue = (baseHue + hueShift + star.hue) % 360;
      const sat = 20 + proximity * 60 + energy * 20;
      const lig = 70 + proximity * 25 + energy * 5;
      const alpha = Math.round(star.brightness * 255 * (0.6 + proximity * 0.4 + energy * 0.2));

      const size = star.size * (1 + proximity * 0.3 + this._flash * 0.15);

      p.fill(hue, sat, lig, alpha);
      p.circle(star.x, star.y, size);
    }

    p.pop();
  }
}
