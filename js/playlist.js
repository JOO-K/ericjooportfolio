// playlist.js — video playlist with cover-fit mask + stable vidEl for custom sources
// - Demo playlist (from CONFIG) still preloads multiple <video>s
// - Upload / Webcam now REUSE the SAME this.vidEl node (no reassignment), so
//   effects that cached playlist.vidEl keep working.

import { CONFIG } from './config.js';

export class VideoPlaylist {
  constructor({ isMobile }) {
    // Demo playlist (desktop vs mobile)
    this.list = isMobile ? CONFIG.VIDEO.MOBILE_PLAYLIST : CONFIG.VIDEO.DESKTOP_PLAYLIST;

    // Player state
    this.videoEls = [];
    this.activeIdx = 0;
    this.vidEl = null;     // <- keep this DOM node stable during custom modes
    this.vidW = 1;
    this.vidH = 1;
    this.loaded = false;

    // Offscreen mask canvas
    this.maskCanvas = document.createElement('canvas');
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.maskCtx.imageSmoothingEnabled = false;
    this.maskData = null;

    // Update throttling
    this.updateCounter = 0;

    // Custom input state (upload / webcam)
    this._mode = 'playlist';     // 'playlist' | 'file' | 'webcam'
    this._customURL = null;      // blob: URL for uploaded file
    this._customStream = null;   // MediaStream for webcam
  }

  /* -------------------- lifecycle -------------------- */

  createHiddenVideo(sources) {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.loop = false;
    v.muted = true;
    v.playsInline = true;
    v.autoplay = false;

    if (Array.isArray(sources)) {
      for (const src of sources) {
        const s = document.createElement('source');
        s.src = src;
        v.appendChild(s);
      }
    } else if (typeof sources === 'string' && sources.length) {
      v.src = sources;
    }

    Object.assign(v.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '1px',
      height: '1px',
      opacity: '0.01',
      pointerEvents: 'none',
      zIndex: '-1',
    });
    document.body.appendChild(v);
    return v;
  }

  init(width, height) {
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;
    if (!this.list || !this.list.length) return;

    // create and start first demo video
    const first = this.createHiddenVideo(this.list[0]);
    this.videoEls[0] = first;

    const onFirstReady = () => {
      this.activeIdx = 0;
      this.vidEl = first; // <- initial stable node (used for custom modes too)
      this.vidW = this.vidEl.videoWidth || 1;
      this.vidH = this.vidEl.videoHeight || 1;
      this.loaded = true;

      this.vidEl.currentTime = 0;
      this.vidEl.play().catch(() => {});
      this.vidEl.addEventListener('ended', () => this.next());

      // Preload remaining demo clips
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
    this._stopCustom();

    // Remove demo videos
    for (const v of this.videoEls) {
      try { v.pause(); } catch {}
      try { v.srcObject = null; } catch {}
      try { v.removeAttribute('src'); v.load(); } catch {}
      try { document.body.removeChild(v); } catch {}
    }
    this.videoEls = [];
    this.vidEl = null;
    this.loaded = false;
    this.maskData = null;
  }

  /* -------------------- demo playlist controls -------------------- */

  next() {
    if (this._mode !== 'playlist') return; // ignore auto-next in custom modes
    if (!this.videoEls.length) return;

    try { this.vidEl?.pause(); } catch {}
    this.activeIdx = (this.activeIdx + 1) % this.videoEls.length;
    this.vidEl = this.videoEls[this.activeIdx]; // (ok to reassign in playlist mode)

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
    this.vidEl.play().catch(() => {});
  }

  /* -------------------- helpers to reuse the SAME node -------------------- */

  _ensureStableNode() {
    // Prefer the current vidEl; otherwise use the first demo element; or create a fresh one.
    if (this.vidEl && document.body.contains(this.vidEl)) return this.vidEl;

    if (this.videoEls[0] && document.body.contains(this.videoEls[0])) {
      this.vidEl = this.videoEls[0];
      return this.vidEl;
    }

    // last resort: create a new hidden video (no sources yet)
    this.vidEl = this.createHiddenVideo('');
    return this.vidEl;
  }

  _pauseAllDemo() {
    for (const v of this.videoEls) {
      try { v.pause(); } catch {}
    }
  }

  /* -------------------- custom sources: upload / webcam -------------------- */

  async useVideoFile(file) {
    const ext = (file.name || '').toLowerCase();
    const okType =
      file.type?.startsWith('video/') ||
      ext.endsWith('.mp4') || ext.endsWith('.webm') || ext.endsWith('.mov') || ext.endsWith('.m4v');

    if (!okType) throw new Error('Unsupported file type');

    try {
      // stop any previous custom stream and pending blob URL
      this._stopCustom();

      const blobURL = URL.createObjectURL(file);

      // Reuse the SAME DOM node
      const v = this._ensureStableNode();
      this._pauseAllDemo();

      // IMPORTANT: reuse node & swap source
      try { v.pause(); } catch {}
      try { v.srcObject = null; } catch {}
      try { v.removeAttribute('src'); } catch {}
      while (v.firstChild) v.removeChild(v.firstChild); // remove any <source> children

      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.preload = 'metadata';
      v.src = blobURL;

      await new Promise((resolve, reject) => {
        const onReady = () => resolve();
        const onErr = (e) => reject(e);
        if (v.readyState >= 2) onReady();
        else {
          v.addEventListener('loadeddata', onReady, { once: true });
          v.addEventListener('error', onErr, { once: true });
        }
        v.load();
      });

      this._mode = 'file';
      this._customURL = blobURL;

      // Keep the SAME reference
      this.vidEl = v;
      this.vidW = v.videoWidth || 1;
      this.vidH = v.videoHeight || 1;
      this.loaded = true;
      this.maskData = null;

      v.currentTime = 0;
      await v.play().catch(() => {});
      return true;
    } catch (e) {
      console.warn('useVideoFile failed:', e);
      this.clearCustom();
      return false;
    }
  }

  async useWebcam() {
    try {
      this._stopCustom();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });

      // Reuse the SAME DOM node
      const v = this._ensureStableNode();
      this._pauseAllDemo();

      try { v.pause(); } catch {}
      try { v.removeAttribute('src'); } catch {}
      while (v.firstChild) v.removeChild(v.firstChild);
      v.srcObject = stream;

      v.loop = false;
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;

      await new Promise((resolve, reject) => {
        const onReady = () => resolve();
        const onErr = (e) => reject(e);
        if (v.readyState >= 2) onReady();
        else {
          v.addEventListener('loadeddata', onReady, { once: true });
          v.addEventListener('error', onErr, { once: true });
        }
        v.load();
      });

      this._mode = 'webcam';
      this._customStream = stream;

      // Keep the SAME reference
      this.vidEl = v;
      this.vidW = v.videoWidth || 1;
      this.vidH = v.videoHeight || 1;
      this.loaded = true;
      this.maskData = null;

      await v.play().catch(() => {});
      return true;
    } catch (e) {
      console.warn('useWebcam failed:', e);
      this.clearCustom();
      return false;
    }
  }

  clearCustom() {
    this._stopCustom();
    // Return to playlist mode: resume current demo element if present
    this._mode = 'playlist';

    if (this.videoEls.length) {
      this.activeIdx = Math.max(0, Math.min(this.activeIdx, this.videoEls.length - 1));
      const demo = this.videoEls[this.activeIdx] || this.videoEls[0];

      // Make the stable node point back to the demo element for playlist mode
      // (ok to change reference when going back to demo)
      this.vidEl = demo;

      this.vidW = this.vidEl.videoWidth || 1;
      this.vidH = this.vidEl.videoHeight || 1;
      this.loaded = true;
      this.maskData = null;
      try {
        this.vidEl.currentTime = 0;
        this.vidEl.play().catch(() => {});
      } catch {}
    } else {
      // Nothing to show
      this.vidEl = null;
      this.loaded = false;
      this.maskData = null;
    }
  }

  _stopCustom() {
    // Stop webcam stream if any
    if (this._customStream) {
      try { this._customStream.getTracks().forEach(t => t.stop?.()); } catch {}
      this._customStream = null;
    }

    // Revoke blob URL if any (do NOT remove node — we now reuse it)
    if (this._customURL) {
      try { URL.revokeObjectURL(this._customURL); } catch {}
      this._customURL = null;
    }
  }

  /* -------------------- mask sampling / cover fit -------------------- */

  updateMask(width, height) {
    const doUpdate =
      (this.updateCounter % CONFIG.VIDEO.UPDATE_PERIOD) < CONFIG.VIDEO.UPDATE_ACTIVE;
    this.updateCounter = (this.updateCounter + 1) % CONFIG.VIDEO.UPDATE_PERIOD;

    if (!doUpdate && this.maskData) return this.maskData;

    const ctx = this.maskCtx;
    ctx.clearRect(0, 0, width, height);
    if (!this.loaded || !this.vidEl) { this.maskData = null; return null; }

    const baseScale = Math.max(width / this.vidW, height / this.vidH);
    const scale = baseScale * (typeof CONFIG.VIDEO.SIL_SCALE === 'number' ? CONFIG.VIDEO.SIL_SCALE : 1.0);
    const dw = this.vidW * scale;
    const dh = this.vidH * scale;
    const dx = (width - dw) * 0.5;
    const dy = (height - dh) * 0.5;

    try {
      ctx.drawImage(this.vidEl, dx, dy, dw, dh);
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
