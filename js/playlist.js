// playlist.js — same as your working version, but video draws with "cover" fit (fills canvas)

import { CONFIG } from './config.js';

export class VideoPlaylist {
  constructor({ isMobile }) {
    this.list = isMobile ? CONFIG.VIDEO.MOBILE_PLAYLIST : CONFIG.VIDEO.DESKTOP_PLAYLIST;
    this.videoEls = [];
    this.activeIdx = 0;
    this.vidEl = null;
    this.vidW = 1; this.vidH = 1; this.loaded = false;

    // offscreen mask canvas
    this.maskCanvas = document.createElement('canvas');
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.maskCtx.imageSmoothingEnabled = false;
    this.maskData = null;

    // throttle sampling
    this.updateCounter = 0;
  }

  createHiddenVideo(sources) {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.loop = false;
    v.muted = true;
    v.playsInline = true; // iOS inline playback
    v.autoplay = false;

    if (Array.isArray(sources)) {
      for (const src of sources) {
        const s = document.createElement('source');
        s.src = src;
        v.appendChild(s);
      }
    } else {
      v.src = sources;
    }

    Object.assign(v.style, {
      position: 'fixed', left: '0px', top: '0px',
      width: '1px', height: '1px', opacity: '0.01',
      pointerEvents: 'none', zIndex: '-1'
    });
    document.body.appendChild(v);
    return v;
  }

  init(width, height) {
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;

    if (!this.list || !this.list.length) return;
    const first = this.createHiddenVideo(this.list[0]);
    this.videoEls[0] = first;

    const onFirstReady = () => {
      this.activeIdx = 0;
      this.vidEl = first;
      this.vidW = this.vidEl.videoWidth || 1;
      this.vidH = this.vidEl.videoHeight || 1;
      this.loaded = true;

      this.vidEl.currentTime = 0;
      this.vidEl.play().catch(()=>{});
      this.vidEl.addEventListener('ended', () => this.next());

      // Preload remaining
      for (let i = 1; i < this.list.length; i++) {
        const v = this.createHiddenVideo(this.list[i]);
        this.videoEls[i] = v;
        v.load();
        v.addEventListener('ended', () => this.next());
      }
    };

    first.addEventListener('loadeddata', onFirstReady, { once: true });
    first.load();
  }

  resize(width, height) {
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;
  }

  dispose() {
    for (const v of this.videoEls) {
      try { v.pause(); } catch(_) {}
      try { document.body.removeChild(v); } catch(_) {}
    }
    this.videoEls = [];
    this.vidEl = null; this.loaded = false;
    this.maskData = null;
  }

  next() {
    if (!this.videoEls.length) return;
    try { this.vidEl.pause(); } catch(_) {}
    this.activeIdx = (this.activeIdx + 1) % this.videoEls.length;
    this.vidEl = this.videoEls[this.activeIdx];

    if (this.vidEl.readyState < 1) {
      this.vidEl.addEventListener('loadeddata', () => {
        this.vidW = this.vidEl.videoWidth || 1;
        this.vidH = this.vidEl.videoHeight || 1;
      }, { once: true });
    } else {
      this.vidW = this.vidEl.videoWidth || 1;
      this.vidH = this.vidEl.videoHeight || 1;
    }
    this.maskData = null;
    this.loaded = true;
    this.vidEl.currentTime = 0;
    this.vidEl.play().catch(()=>{});
  }

  updateMask(width, height) {
    const doUpdate =
      (this.updateCounter % CONFIG.VIDEO.UPDATE_PERIOD) < CONFIG.VIDEO.UPDATE_ACTIVE;
    this.updateCounter = (this.updateCounter + 1) % CONFIG.VIDEO.UPDATE_PERIOD;

    if (!doUpdate && this.maskData) return this.maskData;

    const ctx = this.maskCtx;
    ctx.clearRect(0, 0, width, height);
    if (!this.loaded || !this.vidEl) { this.maskData = null; return null; }

    // ==== COVER FIT (fills canvas; crops if aspect ratios differ) ====
    // base scale to fill the canvas in at least one dimension
    const baseScale = Math.max(width / this.vidW, height / this.vidH);
    // keep your SIL_SCALE knob (e.g., 0.92 if you like it slightly “larger”)
    const scale = baseScale * (typeof CONFIG.VIDEO.SIL_SCALE === 'number' ? CONFIG.VIDEO.SIL_SCALE : 1.0);

    const dw = this.vidW * scale;
    const dh = this.vidH * scale;
    const dx = (width  - dw) * 0.5;
    const dy = (height - dh) * 0.5;

    ctx.drawImage(this.vidEl, dx, dy, dw, dh);

    try {
      this.maskData = ctx.getImageData(0, 0, width, height).data;
    } catch {
      this.maskData = null;
    }
    return this.maskData;
  }

  isSilhouetteAt(maskData, width, height, px, py) {
    if (!maskData) return false;
    const x = px | 0, y = py | 0;
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const idx = (y * width + x) << 2;
    const a = maskData[idx + 3]; if (a < 8) return false;
    const r = maskData[idx], g = maskData[idx + 1], b = maskData[idx + 2];
    const br = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return br < CONFIG.VIDEO.SIL_BRIGHTNESS_THRESHOLD;
  }
}

export default VideoPlaylist;
