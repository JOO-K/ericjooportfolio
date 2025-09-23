// renderer.js — AsciiLayer with storm-grade directional trail + idle auto-clear
import { CONFIG } from './config.js';
import { hashCell } from './utils.js';

export class AsciiLayer {
  constructor(p, gridSize, cols, rows, bgColorRgb) {
    this.p = p;

    // grid + logical layout
    this.grid = gridSize;
    this.cols = cols;
    this.rows = rows;
    this.bg = bgColorRgb;

    // two-buffer pipeline
    this.gAccum = p.createGraphics(p.width, p.height); // accumulation (trail)
    this.gFrame = p.createGraphics(p.width, p.height); // fresh frame
    this.gAccum.clear();
    this.gFrame.clear();

    // text setup
    this._font = null;
    this.gFrame.textAlign(p.CENTER, p.CENTER);
    if (p._defaultFont) this.gFrame.textFont(p._defaultFont);

    // per-cell color palette
    this.cellHSL = [];
    this.randomizePalette();

    // directional trail state (unit vector + strength, plus storm tuning)
    this._trail = {
      vx: 0,                // unit x
      vy: 0,                // unit y
      strength: 0,          // 0..1
      enabled: false,

      // Storm dials:
      decayPerFrame: 0.965,   // higher = longer persistent tail
      pxPerMs: 0.050,         // stronger advection per ms at full strength
      maxTaps: 8,             // more taps = smoother streak
    };

    // when idle (no joystick wind), fully clear in this many ms
    this._autoClearMs = 3500;

    // reusable temp buffers to avoid GC
    this._tmp  = p.createGraphics(p.width, p.height);
    this._pass = p.createGraphics(p.width, p.height);
    this._tmp.clear();
    this._pass.clear();
  }

  // ---------- config & lifecycle ----------

  setFont(font) {
    this._font = font || null;
    if (this._font) this.gFrame.textFont(this._font);
  }

  resize(p, gridSize, cols, rows) {
    this.p = p;
    this.grid = gridSize;
    this.cols = cols;
    this.rows = rows;

    // recreate buffers at new viewport size
    [this.gAccum, this.gFrame, this._tmp, this._pass].forEach(g => g && g.remove());

    this.gAccum = p.createGraphics(p.width, p.height);
    this.gFrame = p.createGraphics(p.width, p.height);
    this._tmp   = p.createGraphics(p.width, p.height);
    this._pass  = p.createGraphics(p.width, p.height);

    this.gAccum.clear();
    this.gFrame.clear();
    this._tmp.clear();
    this._pass.clear();

    this.gFrame.textAlign(p.CENTER, p.CENTER);
    if (this._font) this.gFrame.textFont(this._font);

    this.randomizePalette();
  }

  randomizePalette() {
    const { p, cols, rows } = this;
    this.cellHSL = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => {
        const h = Math.floor(p.random(0, 360));
        const s = 40 + Math.floor(p.random(0, 50));
        const l = 35 + Math.floor(p.random(0, 40));
        return { h, s, l };
      })
    );
  }

  // ---------- fading APIs ----------

  // legacy uniform fade (still works if caller uses it)
  fade(deltaMs = 16.7) {
    const g = this.gAccum;
    const p = this.p;
    if (!g) return;

    const a = 255 * (1 - Math.exp(-(deltaMs) / CONFIG.ASCII_FADE_TAU_MS));
    g.push();
    g.colorMode(p.RGB, 255);
    g.noStroke();
    g.fill(this.bg.r, this.bg.g, this.bg.b, a);
    g.rect(0, 0, g.width, g.height);
    g.pop();
  }

  setDirectionalFade({ vx = 0, vy = 0, strength = 0 }) {
    const len = Math.hypot(vx, vy);
    if (len > 1e-6) { vx /= len; vy /= len; } else { vx = 0; vy = 0; }
    this._trail.vx = vx;
    this._trail.vy = vy;
    this._trail.strength = Math.max(0, Math.min(1, +strength));
    this._trail.enabled = this._trail.strength > 0.001;
  }

  // main compositor: decay + multi-tap advect the trail, then stamp current frame
  fadeDirectional(deltaMs = 16.7) {
    const p   = this.p;
    const acc = this.gAccum;
    const frm = this.gFrame;
    const tmp = this._tmp;
    const pass = this._pass;
    if (!acc || !frm || !tmp || !pass) return;

    const t = this._trail;

    // compute per-deltaMs decay (frame-rate aware)
    const perMs = Math.pow(t.decayPerFrame, 1 / 16.7);
    const decayAlpha = Math.pow(perMs, deltaMs); // 0..1

    // total shift this frame (pixels)
    const totalShift = t.strength * t.pxPerMs * deltaMs;
    const totalDx = t.vx * totalShift;
    const totalDy = t.vy * totalShift;

    // multi-pass advection for stronger, smoother streaks
    const taps = Math.max(1, Math.min(t.maxTaps, Math.floor(1 + t.strength * (t.maxTaps - 1))));
    const dx = totalDx / taps;
    const dy = totalDy / taps;

    // start tmp with the current accumulation
    tmp.clear();
    tmp.image(acc, 0, 0);

    // repeatedly shift + decay using reusable buffers
    for (let i = 0; i < taps; i++) {
      const tapAlpha = Math.pow(decayAlpha, 1 / taps);

      pass.clear();
      pass.push();
      pass.drawingContext.globalAlpha = tapAlpha;
      pass.image(tmp, dx, dy);
      pass.pop();

      // swap: tmp <= pass
      tmp.clear();
      tmp.image(pass, 0, 0);
    }

    // stamp the fresh frame on top at full alpha
    tmp.push();
    tmp.drawingContext.globalAlpha = 1.0;
    tmp.image(frm, 0, 0);
    tmp.pop();

    // optional: tiny smear along the wind for extra aggression
    if (t.strength > 0.001) {
      const smear = Math.min(3.0, 0.9 + t.strength * 2.2); // px
      tmp.push();
      tmp.drawingContext.globalAlpha = 0.35 * t.strength;
      tmp.image(frm, t.vx * smear, t.vy * smear);
      tmp.pop();
    }

    // copy tmp back to accumulator
    acc.clear();
    acc.image(tmp, 0, 0);

    // clear the per-frame buffer for the next draw call
    frm.clear();

    // ---- idle auto-clear: if there's no wind, linearly clear to bg in ~3.5s ----
    if (t.strength <= 0.001 && this._autoClearMs > 0) {
      const k = Math.min(1, deltaMs / this._autoClearMs); // fraction of full clear this frame
      acc.push();
      acc.colorMode(p.RGB, 255);
      acc.noStroke();
      acc.fill(this.bg.r, this.bg.g, this.bg.b, 255 * k);
      acc.rect(0, 0, acc.width, acc.height);
      acc.pop();
      // after ~sum(deltaMs) == _autoClearMs, the trail is fully gone
    }
  }

  // ---------- ASCII glyph generation ----------

  charForFrame(gx, gy, tick) {
    const r = hashCell(
      gx * 123.45 + gy * 987.65 + tick * 0.777,
      gy * 456.78 + tick * 1.234
    );
    const idx = Math.floor(r * CONFIG.CHARSET.length) % CONFIG.CHARSET.length;
    return CONFIG.CHARSET.charAt(idx);
  }

  // Renders THIS FRAME into gFrame (not directly to screen)
  draw(maskData, isSilAt, charTick) {
    const { p, gFrame: gfx, cols, rows, grid, cellHSL } = this;
    if (!gfx) return;

    // clear only the frame buffer; the trail buffer is handled elsewhere
    gfx.clear();

    gfx.push();
    gfx.colorMode(p.HSL, 360, 100, 100, 255);

    for (let gy = 0; gy < rows; gy++) {
      const cy = gy * grid + grid / 2;
      for (let gx = 0; gx < cols; gx++) {
        const cx = gx * grid + grid / 2;

        if (!isSilAt(maskData, p.width, p.height, cx, cy)) continue;

        const { h, s, l } = cellHSL[gy][gx];
        const ch = this.charForFrame(gx, gy, charTick);

        gfx.fill(h, s, l, 235);
        gfx.textSize(grid * 1.15);
        gfx.text(ch, cx, cy);
      }
    }

    gfx.pop();
  }

  // Present the accumulation buffer to the main canvas
  blitTo(p) {
    if (this.gAccum) p.image(this.gAccum, 0, 0);
  }
}
