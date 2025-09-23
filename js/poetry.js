import { CONFIG } from './config.js';
import { hexToRgb, hashCell } from './utils.js';
import { VideoPlaylist } from './playlist.js';
import { TrailDrip, resetOccupancy } from './traildrip.js';

export class PoetrySilhouetteEffect {
  constructor() {
    this.name = 'Poetry Silhouette + Drips';

    this.font = null;
    this.images = [];
    this.grid = CONFIG.GRID_DESKTOP;
    this.cols = 0; this.rows = 0;

    this.video = null;
    this.maskData = null;

    this.layer = null;
    this.bgRgb = hexToRgb(CONFIG.BG_COLOR);

    this.palette = [];
    this.words = (window && Array.isArray(window.POETRY_WORDS) && window.POETRY_WORDS.length)
      ? window.POETRY_WORDS
      : CONFIG.POETRY_DEFAULT_WORDS.slice();

    this.lastWordTickAt = 0;
    this.wordTick = 0;

    this.pX = -9999; this.pY = -9999;
    this.drips = [];

    // per-frame word occupancy (to prevent overlaps)
    this.wordOcc = null;
  }
preload(p) {
  // No file load needed, we’ll just set the family later
}

setup(p) {
  // …
  this.layer = p.createGraphics(p.width, p.height);
  this.layer.textAlign(p.CENTER, p.CENTER);

  // 👉 set by family name
  this.layer.textFont(CONFIG.POETRY_FONT_FAMILY);

  this.layer.noStroke();
  this.randomizePalette(p);
  // …
}

resize(p) {
  // …
  this.layer = p.createGraphics(p.width, p.height);
  this.layer.textAlign(p.CENTER, p.CENTER);

  // 👉 again
  this.layer.textFont(CONFIG.POETRY_FONT_FAMILY);

  this.layer.noStroke();
  this.randomizePalette(p);
  // …
}


  randomizePalette(p) {
    this.palette = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => {
        const h = Math.floor(p.random(0, 360));
        const s = 45 + Math.floor(p.random(0, 45));
        const l = 40 + Math.floor(p.random(0, 35));
        return { h, s, l };
      })
    );
  }

  brightnessAt(px, py, p) {
    const m = this.maskData;
    if (!m) return 255;
    const x = px | 0, y = py | 0;
    if (x < 0 || y < 0 || x >= p.width || y >= p.height) return 255;
    const i = (y * p.width + x) << 2;
    const a = m[i + 3]; if (a < 8) return 255;
    const r = m[i], g = m[i + 1], b = m[i + 2];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  isSilhouetteAt(px, py, p) {
    // If mask not ready yet → show EVERYTHING so user sees immediate output.
    if (!this.maskData) return true;
    return this.brightnessAt(px, py, p) < CONFIG.VIDEO.SIL_BRIGHTNESS_THRESHOLD;
  }

  attachPointer(p) {
    const c = p._renderer?.elt || p.canvas;
    const upd = (x, y) => {
      const r = c.getBoundingClientRect();
      const sx = p.width / r.width, sy = p.height / r.height;
      this.pX = (x - r.left) * sx;
      this.pY = (y - r.top)  * sy;
    };
    c.addEventListener('pointermove', e => upd(e.clientX, e.clientY), { passive: true });
    c.addEventListener('pointerenter', e => upd(e.clientX, e.clientY), { passive: true });
    c.addEventListener('pointerleave', () => { this.pX = this.pY = -9999; }, { passive: true });
    c.addEventListener('pointerdown', e => { upd(e.clientX, e.clientY); this.spawnDripsAtPointer(p); });
    c.addEventListener('touchstart', e => { const t = e.touches[0]; if (t) upd(t.clientX, t.clientY); this.spawnDripsAtPointer(p); }, { passive: true });
    c.addEventListener('touchmove', e => { const t = e.touches[0]; if (t) upd(t.clientX, t.clientY); }, { passive: true });
  }

  spawnDripsAtPointer(p) {
    if (!(this.pX >= 0 && this.pY >= 0 && this.pX <= p.width && this.pY <= p.height)) return;
    const baseCol = Math.max(0, Math.min(this.cols - 1, Math.floor(this.pX / this.grid)));
    const baseRow = Math.floor(this.pY / this.grid) - 1;
    for (let i = 0; i < CONFIG.DRIPS.CLICK_SPAWN_COUNT; i++) {
      const c = Math.max(0, Math.min(this.cols - 1,
                baseCol + Math.floor(p.random(-CONFIG.DRIPS.CLICK_SCATTER_COLS,
                                              CONFIG.DRIPS.CLICK_SCATTER_COLS + 1))));
      this.drips.push(new TrailDrip(p, this.grid, this.cols, this.rows, c, baseRow,
                        (cc, rr) => this.imageAt(cc, rr)));
    }
  }

  imageAt(col, row) {
    if (!this.images.length) return null;
    const idx = Math.floor(hashCell(col + 222, row + 444) * this.images.length);
    return this.images[idx % this.images.length];
  }

  wordForCell(gx, gy, tick, p) {
    // prefer longer words in darker areas (Max Cooper vibe)
    const cx = gx * this.grid + this.grid * 0.5;
    const cy = gy * this.grid + this.grid * 0.5;
    const br = this.brightnessAt(cx, cy, p);      // 0..255
    const darkness = 1 - Math.min(Math.max(br / 255, 0), 1); // 0..1

    const short = [], medium = [], long = [];
    for (const w of this.words) {
      if (w.length <= 5) short.push(w);
      else if (w.length <= 9) medium.push(w);
      else long.push(w);
    }

    const pool = (darkness > 0.66 && long.length) ? long
               : (darkness > 0.33 && medium.length) ? medium
               : (short.length ? short : this.words);

    const r = hashCell(gx * 531.17 + gy * 991.42 + tick * 0.777,
                       gy * 713.99 + tick * 1.234);
    return pool[Math.floor(r * pool.length) % pool.length];
  }

  _resetWordOcc() {
    this.wordOcc = Array.from({ length: this.rows }, () => Array(this.cols).fill(false));
  }
  _canPlaceSpan(gx, gy, span) {
    if (gx < 0 || gy < 0 || gx + span > this.cols || gy >= this.rows) return false;
    for (let x = gx; x < gx + span; x++) if (this.wordOcc[gy][x]) return false;
    return true;
  }
  _placeSpan(gx, gy, span) { for (let x = gx; x < gx + span; x++) this.wordOcc[gy][x] = true; }

  update(p, deltaMs) {
  // SAFETY: video may not be ready yet (or was disposed during a switch)
  if (this.video && typeof this.video.updateMask === 'function') {
    this.maskData = this.video.updateMask(p.width, p.height);
  } else {
    this.maskData = null; // draw fallback (full-canvas poetry) until ready
  }

  // cadence: update words
  if (p.millis() - this.lastWordTickAt >= CONFIG.CHAR_REFRESH_MS) {
    this.wordTick++;
    this.lastWordTickAt = p.millis();
  }

  // temporal fade toward BG
  const a = 255 * (1 - Math.exp(-(deltaMs || 16.7) / CONFIG.ASCII_FADE_TAU_MS));
  this.layer.push();
  this.layer.colorMode(p.RGB, 255);
  this.layer.noStroke();
  this.layer.fill(this.bgRgb.r, this.bgRgb.g, this.bgRgb.b, a);
  this.layer.rect(0, 0, this.layer.width, this.layer.height);
  this.layer.pop();

  // drips update
  for (let i = this.drips.length - 1; i >= 0; i--) {
    const d = this.drips[i];
    d.update();
    if (d.isDone()) this.drips.splice(i, 1);
  }
}


  draw(p) {
    p.background(CONFIG.BG_COLOR);

    // PACK WORDS WITHOUT OVERLAP
    this._resetWordOcc();

    this.layer.push();
    this.layer.colorMode(p.HSL, 360, 100, 100, 255);
    if (this.font) this.layer.textFont(this.font);

    // size tuned for legibility — bold, a hair under the tile height
    const lineH = Math.max(10, this.grid * 0.92);
    this.layer.textSize(lineH);

    for (let gy = 0; gy < this.rows; gy++) {
      let gx = 0;
      while (gx < this.cols) {
        const cx = gx * this.grid + this.grid * 0.5;
        const cy = gy * this.grid + this.grid * 0.5;

        if (!this.isSilhouetteAt(cx, cy, p)) { gx++; continue; }

        const word = this.wordForCell(gx, gy, this.wordTick, p);

        // measure word and compute span in tiles, with padding
        const wpx = this.layer.textWidth(word) * 1.08; // slight padding
        let span = Math.max(1, Math.ceil(wpx / this.grid));
        span = Math.min(span, this.cols - gx);

        // ensure span sits fully inside silhouette (sample midpoints)
        let inside = true;
        for (let x = 0; x < span; x++) {
          const sx = (gx + x + 0.5) * this.grid;
          if (!this.isSilhouetteAt(sx, cy, p)) { inside = false; break; }
        }
        if (!inside) { gx++; continue; }

        // try to place at full span, otherwise shrink
        let placed = false;
        for (let trySpan = span; trySpan >= 1; trySpan--) {
          if (this._canPlaceSpan(gx, gy, trySpan)) {
            const { h, s, l } = this.palette[gy][gx];
            this.layer.fill(h, s, l, 240);
            const midX = (gx + trySpan / 2) * this.grid;
            this.layer.text(word, midX, cy);
            this._placeSpan(gx, gy, trySpan);
            gx += trySpan;
            placed = true;
            break;
          }
        }
        if (!placed) gx++;
      }
    }

    // optional debug: show silhouette sample points
    if (CONFIG.DEBUG_SILHOUETTE) {
      this.layer.push();
      this.layer.noFill();
      this.layer.stroke(120, 100, 50, 200);
      for (let gy = 0; gy < this.rows; gy++) {
        for (let gx = 0; gx < this.cols; gx++) {
          const cx = gx * this.grid + this.grid * 0.5;
          const cy = gy * this.grid + this.grid * 0.5;
          if (this.isSilhouetteAt(cx, cy, p))
            this.layer.rect(gx * this.grid, gy * this.grid, this.grid, this.grid);
        }
      }
      this.layer.pop();
    }

    this.layer.pop();

    // blit the words layer
    p.image(this.layer, 0, 0);

    // drips on top
    p.colorMode(p.RGB, 255);
    for (const d of this.drips) d.draw();
  }
}
