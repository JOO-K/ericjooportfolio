import { CONFIG } from './config.js';
import { hashCell, drawImageCover } from './utils.js';

// shared occupancy grid for image segments
let occ = [];
export function resetOccupancy(cols, rows) {
  occ = Array.from({ length: rows }, () => Array(cols).fill(null));
}
function canPlaceRect(cols, rows, c, r, w, h) {
  if (c < 0 || c + w > cols) return false;
  const r0 = Math.max(0, r), r1 = Math.min(rows, r + h);
  for (let y = r0; y < r1; y++) for (let x = c; x < c + w; x++)
    if (occ[y][x] !== null) return false;
  return true;
}
function placeRect(id, c, r, w, h) {
  const rows = occ.length; if (!rows) return;
  const r0 = Math.max(0, r), r1 = Math.min(rows, r + h);
  for (let y = r0; y < r1; y++) for (let x = c; x < c + w; x++) occ[y][x] = id;
}
function freeRectById(id, c, r, w, h) {
  const rows = occ.length; if (!rows) return;
  const r0 = Math.max(0, r), r1 = Math.min(rows, r + h);
  for (let y = r0; y < r1; y++) for (let x = c; x < c + w; x++)
    if (occ[y][x] === id) occ[y][x] = null;
}

export class TrailDrip {
  constructor(p, grid, cols, rows, startCol, startRow, getImageAt) {
    this.p = p; this.grid = grid; this.cols = cols; this.rows = rows;
    this.getImageAt = getImageAt;

    this.id = TrailDrip._nextId++;
    this.finished = false;
    this.finishAt = null;
    this.nextStepAt = p.millis();
    this.segments = [];   // {c,r,w,h,img,born,_freedOcc:false}

    const r0 = Math.max(CONFIG.DRIPS.START_ROW_MIN, Math.min(rows - 1, startRow));
    const c0 = Math.max(0, Math.min(cols - 1, startCol));
    const seg = { c: c0, r: r0, w: 1, h: 1,
                  img: this.getImageAt(c0, r0), born: p.millis(), _freedOcc:false };
    this.segments.push(seg);
    placeRect(this.id, seg.c, seg.r, seg.w, seg.h);
  }

  static _sizeFromProgress(progress, prevSize, cols, rows) {
    const prev = prevSize || 1;
    if (progress <= CONFIG.DRIPS.GROWTH_START) return { w: prev, h: prev };
    const p = (progress - CONFIG.DRIPS.GROWTH_START) / (1 - CONFIG.DRIPS.GROWTH_START);
    const eased = Math.pow(Math.min(Math.max(p,0),1), CONFIG.DRIPS.GROWTH_EASE);
    let s = 1 + Math.floor(eased * (CONFIG.DRIPS.MAX_SIZE - 1) + 1e-6);
    s = Math.max(prev, Math.min(prev + 1, s));
    s = Math.min(s, CONFIG.DRIPS.MAX_SIZE, cols, rows);
    return { w: s, h: s };
  }

  _progressFor(prev) {
    const bottomRow = prev.r + prev.h;
    return Math.min(Math.max(bottomRow / this.rows, 0), 1);
  }

  _tryNextSegment(prev) {
    const pick = TrailDrip._sizeFromProgress(
      this._progressFor(prev), prev.w, this.cols, this.rows
    );
    const newRow = prev.r + prev.h;

    for (let s = pick.w; s >= 1; s--) {
      const prevL = prev.c, prevR = prev.c + prev.w - 1;
      let minC = Math.max(0, prevL - (s - 1));
      let maxC = Math.min(this.cols - s, prevR);
      if (minC > maxC) continue;

      for (let tries = 10; tries-- > 0; ) {
        const c = Math.floor(this.p.random(minC, maxC + 1));
        if (canPlaceRect(this.cols, this.rows, c, newRow, s, s))
          return { c, r: newRow, w: s, h: s };
      }
      for (let c = minC; c <= maxC; c++)
        if (canPlaceRect(this.cols, this.rows, c, newRow, s, s))
          return { c, r: newRow, w: s, h: s };
    }
    return null;
  }

  _finalBottomPlacement(prev) {
    const prevL = prev.c, prevR = prev.c + prev.w - 1;
    for (let s = Math.min(CONFIG.DRIPS.MAX_SIZE, this.cols, this.rows); s >= 1; s--) {
      let minC = Math.max(0, prevL - (s - 1));
      let maxC = Math.min(this.cols - s, prevR);
      if (minC > maxC) continue;
      const r = this.rows - s;
      for (let tries = 10; tries-- > 0;) {
        const c = Math.floor(this.p.random(minC, maxC + 1));
        if (canPlaceRect(this.cols, this.rows, c, r, s, s)) return { c, r, w: s, h: s };
      }
      for (let c = minC; c <= maxC; c++)
        if (canPlaceRect(this.cols, this.rows, c, r, s, s)) return { c, r, w: s, h: s };
    }
    return null;
  }

  _stepOnce() {
    if (this.finished) return;

    const prev = this.segments[this.segments.length - 1];
    let next = this._tryNextSegment(prev);

    if (!next) {
      const finalSeg = this._finalBottomPlacement(prev);
      if (finalSeg) {
        finalSeg.img = this.getImageAt(finalSeg.c, finalSeg.r);
        finalSeg.born = this.p.millis();
        finalSeg._freedOcc = false;
        this.segments.push(finalSeg);
        placeRect(this.id, finalSeg.c, finalSeg.r, finalSeg.w, finalSeg.h);
        this.finished = true;
        this.finishAt = this.p.millis();
      } else {
        this.nextStepAt = this.p.millis() + 120;
      }
      return;
    }

    if (next.r + next.h >= this.rows) {
      next.r = this.rows - next.h;
      const finalSeg = this._finalBottomPlacement(prev);
      if (finalSeg) {
        finalSeg.img = this.getImageAt(finalSeg.c, finalSeg.r);
        finalSeg.born = this.p.millis();
        finalSeg._freedOcc = false;
        this.segments.push(finalSeg);
        placeRect(this.id, finalSeg.c, finalSeg.r, finalSeg.w, finalSeg.h);
        this.finished = true;
        this.finishAt = this.p.millis();
      } else {
        this.nextStepAt = this.p.millis() + 120;
      }
      return;
    }

    next.img = this.getImageAt(next.c, next.r);
    next.born = this.p.millis();
    next._freedOcc = false;
    this.segments.push(next);
    placeRect(this.id, next.c, next.r, next.w, next.h);
  }

  update() {
    if (this.finished) return;
    const now = this.p.millis();
    let safety = CONFIG.DRIPS.MAX_STEPS_PER_UPDATE;
    while (now >= this.nextStepAt && safety-- > 0) {
      this._stepOnce();
      this.nextStepAt += this.p.random(CONFIG.DRIPS.STEP_MS_MIN, CONFIG.DRIPS.STEP_MS_MAX);
      if (this.finished) break;
    }
  }

  draw() {
    const p = this.p, now = p.millis();
    const lastIndex = this.segments.length - 1;

    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      let alpha = 255;

      if (!this.finished) {
        alpha = 255;
      } else {
        if (i < lastIndex) {
          const lived = this.finishAt - s.born;
          const delay = lived * CONFIG.DRIPS.SEGMENT_FADE_DELAY_FACTOR;
          const startFade = this.finishAt + delay;
          if (now > startFade) {
            const k = (now - startFade) / CONFIG.DRIPS.SEGMENT_FADE_MS;
            alpha = Math.max(0, 255 * (1 - k));
          }
          if (alpha <= 0 && !s._freedOcc) { freeRectById(this.id, s.c, s.r, s.w, s.h); s._freedOcc = true; continue; }
          if (alpha <= 0) continue;
        } else {
          const hold = CONFIG.DRIPS.FINAL_FADE_DELAY_MS;
          if (now > this.finishAt + hold) {
            const k = (now - (this.finishAt + hold)) / CONFIG.DRIPS.FINAL_FADE_MS;
            alpha = Math.max(0, 255 * (1 - k));
            if (alpha <= 0 && !s._freedOcc) { freeRectById(this.id, s.c, s.r, s.w, s.h); s._freedOcc = true; continue; }
            if (alpha <= 0) continue;
          }
        }
      }

      drawImageCover(p, s.img, s.c * this.grid, s.r * this.grid, s.w * this.grid, s.h * this.grid, alpha);
    }
  }

  isDone() {
    if (!this.finished) return false;
    const now = this.p.millis();
    const finalGone = now > this.finishAt + CONFIG.DRIPS.FINAL_FADE_DELAY_MS + CONFIG.DRIPS.FINAL_FADE_MS;
    if (!finalGone) return false;

    for (let i = 0; i < this.segments.length - 1; i++) {
      const seg = this.segments[i];
      const lived = this.finishAt - seg.born;
      const delay = lived * CONFIG.DRIPS.SEGMENT_FADE_DELAY_FACTOR;
      const startFade = this.finishAt + delay;
      if (now < startFade + CONFIG.DRIPS.SEGMENT_FADE_MS) return false;
    }
    return true;
  }
}
TrailDrip._nextId = 1;

export { canPlaceRect, placeRect, freeRectById };
