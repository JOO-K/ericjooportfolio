// videohover.js — mouse-reactive hover grid with click explosions (snappier return)
import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';

class HoverPoint {
  constructor(x0, y0) {
    this.x0 = x0; this.y0 = y0;
    this.x  = x0; this.y  = y0;
    this.vx = 0;  this.vy = 0;
  }
  step(ax, ay, dt, damping) {
    this.vx = (this.vx + ax * dt) * damping;
    this.vy = (this.vy + ay * dt) * damping;
    this.x  += this.vx * dt;
    this.y  += this.vy * dt;
  }
}

export class VideoHoverSilhouetteEffect {
  constructor() {
    this.name = 'Video Hover Grid (silhouette)';

    // video & mask
    this.video = null;
    this.maskData = null;

    // grid / density
    this.cellDesktop = Math.max(18, CONFIG.GRID_DESKTOP);
    this.cellMobile  = Math.max(10, CONFIG.GRID_MOBILE);
    this.grid = this.cellDesktop;
    this.cols = 0; this.rows = 0;

    // physics / feel (SNAPPIER)
    this.influenceRadius = 140;
    this.mouseStrength   = 1200;
    this.returnK         = 9.0;   // ↑ was 5.0
    this.damping         = 0.88;  // ↑ was 0.86 (more drag = settles sooner)

    // CLICK/TAP explosion
    this.explosionRadius    = 220;
    this.explosionStrength  = 2400;
    this.explosionJitter    = 0.15;
    this.explosionCooldownMs= 140;
    this._lastExplodeAt     = 0;

    // rendering
    this.strokeBase  = 1.1;
    this.strokeBoost = 2.0;
    this.shapeScale  = 0.52;
    this.colorLight  = 235;
    this.colorDark   = 160;

    // data
    this.points = [];
    this.mouseX = -9999; this.mouseY = -9999;
  }

  preload(p) {}

  _rebuildGrid(p) {
    this.grid = (p.windowWidth <= 800) ? this.cellMobile : this.cellDesktop;
    this.cols = Math.floor(p.width  / this.grid);
    this.rows = Math.floor(p.height / this.grid);

    this.points = [];
    for (let gy = 0; gy < this.rows; gy++) {
      for (let gx = 0; gx < this.cols; gx++) {
        const x = gx * this.grid + this.grid * 0.5;
        const y = gy * this.grid + this.grid * 0.5;
        this.points.push(new HoverPoint(x, y));
      }
    }
  }

  setup(p) {
    p.strokeCap(p.ROUND);
    p.strokeJoin(p.ROUND);

    const isMobile = p.windowWidth <= 800;
    this.video = new VideoPlaylist({ isMobile });
    this.video.init(p.width, p.height);

    this._rebuildGrid(p);

    const canvas = p._renderer?.elt || p.canvas;
    const upd = (x, y) => {
      const r = canvas.getBoundingClientRect();
      const sx = p.width / r.width, sy = p.height / r.height;
      this.mouseX = (x - r.left) * sx;
      this.mouseY = (y - r.top)  * sy;
    };
    const explodeEvt = (x, y) => { upd(x, y); this.explodeAt(this.mouseX, this.mouseY, p); };

    canvas.addEventListener('pointermove', e => upd(e.clientX, e.clientY), { passive:true });
    canvas.addEventListener('pointerenter', e => upd(e.clientX, e.clientY), { passive:true });
    canvas.addEventListener('pointerleave', () => { this.mouseX = this.mouseY = -9999; }, { passive:true });

    canvas.addEventListener('pointerdown', e => explodeEvt(e.clientX, e.clientY), { passive:true });
    canvas.addEventListener('touchstart',  e => { const t = e.touches[0]; if (t) explodeEvt(t.clientX, t.clientY); }, { passive:true });
    canvas.addEventListener('touchmove',   e => { const t = e.touches[0]; if (t) upd(t.clientX, t.clientY); }, { passive:true });
  }

  dispose() { this.video?.dispose?.(); }

  resize(p) {
    this.video?.resize(p.width, p.height);
    this._rebuildGrid(p);
  }

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
  _isSilhouette(px, py, p) {
    if (this.video?.isSilhouetteAt)
      return this.video.isSilhouetteAt(this.maskData, p.width, p.height, px, py);
    return this._brightnessAt(px, py, p) < CONFIG.VIDEO.SIL_BRIGHTNESS_THRESHOLD;
  }

  explodeAt(x, y, p) {
    const now = performance.now ? performance.now() : Date.now();
    if (now - this._lastExplodeAt < this.explosionCooldownMs) return;
    this._lastExplodeAt = now;

    const R = this.explosionRadius;
    const R2 = (R === Infinity) ? Infinity : R * R;
    const S = this.explosionStrength;

    for (let i = 0; i < this.points.length; i++) {
      const pt = this.points[i];
      const dx = pt.x - x, dy = pt.y - y;
      const d2 = dx*dx + dy*dy;
      if (d2 > R2) continue;

      const d  = Math.sqrt(Math.max(d2, 1e-6));
      const fall = (R === Infinity) ? 1 : (1 - d / R);
      const jitterA = (Math.random() - 0.5) * Math.PI * 2 * this.explosionJitter;
      const ang = Math.atan2(dy, dx) + jitterA;
      const impulse = S * fall * fall;

      pt.vx += Math.cos(ang) * impulse;
      pt.vy += Math.sin(ang) * impulse;
    }
  }

  update(p, dtMs) {
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;

    const dt = Math.max(0.001, Math.min(0.033, (dtMs || 16.7) / 1000));

    const mx = this.mouseX, my = this.mouseY;
    const r2 = this.influenceRadius * this.influenceRadius;

    for (let i = 0; i < this.points.length; i++) {
      const pt = this.points[i];

      let ax = 0, ay = 0;
      if (mx > -9998) {
        const dx = mx - pt.x, dy = my - pt.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < r2 && d2 > 1e-2) {
          const d  = Math.sqrt(d2);
          const w  = 1 - (d / this.influenceRadius);
          const f  = this.mouseStrength * w * w;
          ax += (dx / d) * f;
          ay += (dy / d) * f;
        }
      }

      ax += (pt.x0 - pt.x) * this.returnK;
      ay += (pt.y0 - pt.y) * this.returnK;

      pt.step(ax, ay, dt, this.damping);
    }

    p.background(CONFIG.BG_COLOR);
  }

  draw(p) {
    const cell = this.grid;
    const half = (cell * this.shapeScale) * 0.5;

    for (let i = 0; i < this.points.length; i++) {
      const pt = this.points[i];
      if (!this._isSilhouette(pt.x, pt.y, p)) continue;

      const br = this._brightnessAt(pt.x, pt.y, p);
      const darkness = 1 - Math.min(Math.max(br / 255, 0), 1);
      const vm = Math.hypot(pt.vx, pt.vy);
      const w  = this.strokeBase + (this.strokeBoost * darkness) + Math.min(2.5, vm * 0.02);

      const c  = Math.floor(this.colorDark + (this.colorLight - this.colorDark) * (0.6 + 0.4 * darkness));
      p.stroke(c);
      p.strokeWeight(w);
      p.noFill();

      const ang = Math.atan2(pt.vy, pt.vx);
      p.push();
      p.translate(pt.x, pt.y);
      p.rotate(ang * 0.5);
      p.line(-half, 0, half, 0);
      p.line(0, -half, 0, half);
      p.pop();
    }
  }
}

export default VideoHoverSilhouetteEffect;
