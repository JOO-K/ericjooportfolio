// app.js — viewport-locked canvas, loader, dock (tiny source icons + joystick + preview + dots)
// + auto-shuffle every 8s until user interacts

import { AsciiSilhouetteEffect } from './ascii.js';
import VideoThresholdEffect from './videothreshold.js';
import VideoConnectedParticlesEffect from './videoparticles.js';
import VideoBezierOutlineEffect from './videobezier.js';
import VideoMosaicPanelsEffect from './videomosaic.js';
import { VideoPlaylist } from './playlist.js';

let currentEffect = null;
let p5Instance = null;
let sharedPlaylist = null;
// START WITH VIDEO THRESHOLD FIRST
let currentKey = 'video+threshold';

// --- auto-rotate state ---
let autoRotateTimer = null;
let userInteracted = false;
const ROTATE_MS = 8000;

// --- loader helpers (from index.html) ---
const show = (...a) => window.showLoader?.(...a);
const setP  = (...a) => window.setLoaderProgress?.(...a);
const hide = (...a) => window.hideLoader?.(...a);

const EFFECTS = {
  'ascii+drips'     : (opts) => new AsciiSilhouetteEffect(opts),
  'video+threshold' : (opts) => new VideoThresholdEffect(opts),
  'video+particles' : (opts) => new VideoConnectedParticlesEffect(opts),
  'video+bezier'    : (opts) => new VideoBezierOutlineEffect(opts),
  'video+mosaic'    : (opts) => new VideoMosaicPanelsEffect(opts),
};

// Thumbnails for preview
const EFFECT_META = {
  'ascii+drips'     : { title: 'ASCII + Drips',               thumb: './images/effect_01.png' },
  'video+threshold' : { title: 'ASCII Video Threshold',       thumb: './images/effect_02.png' },
  'video+particles' : { title: 'Video Connected Particles',   thumb: './images/effect_03.png' },
  'video+bezier'    : { title: 'Video Bezier Outline',        thumb: './images/effect_04.png' },
  'video+mosaic'    : { title: 'Video Mosaic Panels',         thumb: './images/effect_05.png' },
};

/* =======================
   Core app lifecycle
   ======================= */

function lockViewportNoScroll() {
  document.documentElement.style.overflow = 'hidden';
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
}

function sizeCanvasToViewport(p) {
  const w = Math.floor(window.innerWidth);
  const h = Math.floor(window.innerHeight);
  p.resizeCanvas(w, h);
  const c = p._renderer?.elt || p.canvas;
  if (c) {
    c.style.position = 'fixed';
    c.style.top = '0';
    c.style.left = '0';
    c.style.width = '100vw';
    c.style.height = '100vh';
    c.style.display = 'block';
    c.style.zIndex = '0'; // keep canvas at the bottom
  }
}

function boot(effectKey = currentKey) {
  show(); setP(5);

  currentKey = effectKey;
  // FALLBACK TO VIDEO THRESHOLD
  const make = EFFECTS[effectKey] || EFFECTS['video+threshold'];
  currentEffect = make({ playlist: sharedPlaylist });

  // eslint-disable-next-line no-undef
  p5Instance = new p5((p) => {
    let lastMs = 0;
    let firstFrameDone = false;

    p.preload = () => {
      setP(20);
      currentEffect.preload?.(p);
    };

    p.setup = () => {
      lockViewportNoScroll();

      p.pixelDensity(1);
      p.createCanvas(1, 1);
      sizeCanvasToViewport(p);
      p.textAlign(p.CENTER, p.CENTER);
      setP(35);

      if (!sharedPlaylist) {
        const isMobile = p.windowWidth <= 800;
        sharedPlaylist = new VideoPlaylist({ isMobile });
        sharedPlaylist.init(p.width, p.height);
      } else {
        sharedPlaylist.resize(p.width, p.height);
      }
      setP(55);

      if (currentEffect && !currentEffect.video) currentEffect.video = sharedPlaylist;
      currentEffect.setup?.(p);
      setP(70);

      wireDock(onJoystickInput);   // build tiny source icons + joystick + preview + dots
      setActiveDot(effectKey);
      syncDockSizes();
      setP(85);

      // kick off auto-rotation (only once)
      startAutoRotate();
      setP(90);
    };

    p.windowResized = () => {
      sizeCanvasToViewport(p);
      sharedPlaylist?.resize(p.width, p.height);
      currentEffect.resize?.(p);
      syncDockSizes();
    };

    p.draw = () => {
      const now = p.millis();
      const dt = lastMs ? (now - lastMs) : 16.7;
      lastMs = now;
      currentEffect.update?.(p, dt);
      currentEffect.draw?.(p);

      if (!firstFrameDone) {
        firstFrameDone = true;
        setP(100);
        setTimeout(() => hide(), 180);
      }
    };
  });
}

function switchEffect(key) {
  if (!EFFECTS[key]) return;

  // IMPORTANT: do NOT call currentEffect.dispose() here.
  // Some effects dispose the shared VideoPlaylist, which resets the source.
  // Tearing down the p5 instance is sufficient.
  if (p5Instance) {
    p5Instance.remove();
    p5Instance = null;
  }

  setActiveDot(key);
  setTimeout(() => boot(key), 0);
}

/* =======================
   Auto-rotate (8s) until user interacts
   ======================= */

function getEffectOrder() {
  // VIDEO THRESHOLD FIRST IN ROTATION
  return ['video+threshold', 'ascii+drips', 'video+particles', 'video+bezier', 'video+mosaic'];
}

function rotateToNext() {
  const order = getEffectOrder();
  const idx = Math.max(0, order.indexOf(currentKey));
  const next = order[(idx + 1) % order.length];
  switchEffect(next);
}

function startAutoRotate() {
  if (autoRotateTimer || userInteracted) return;
  autoRotateTimer = setInterval(() => {
    if (userInteracted) { stopAutoRotate(); return; }
    rotateToNext();
  }, ROTATE_MS);
}

function stopAutoRotate() {
  if (autoRotateTimer) {
    clearInterval(autoRotateTimer);
    autoRotateTimer = null;
  }
}

/* =======================
   Tiny helpers
   ======================= */
function mk(el, style = {}) { const e = document.createElement(el); Object.assign(e.style, style); return e; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function flash(el, text = '') {
  try {
    const tag = mk('div', {
      position: 'absolute', right: '0', bottom: '100%', marginBottom: '6px',
      padding: '6px 8px', borderRadius: '8px', fontSize: '11px',
      background: 'rgba(230,232,240,0.9)', color: '#0e111a',
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)', opacity: '0',
      transform: 'translateY(4px)', transition: 'all 160ms ease', pointerEvents: 'none',
    });
    tag.textContent = text;
    el.style.position = 'relative';
    el.appendChild(tag);
    requestAnimationFrame(() => { tag.style.opacity = '1'; tag.style.transform = 'translateY(0)'; });
    setTimeout(() => { tag.style.opacity = '0'; tag.style.transform = 'translateY(4px)'; setTimeout(() => tag.remove(), 160); }, 900);
  } catch {}
}
const isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/* =======================
   VIDEO SOURCE SWITCHERS (no playlist.js changes needed)
   ======================= */

let _customBlobURL = null;
let _webcamStream = null;

async function useFileAsSource(file) {
  if (!file || !sharedPlaylist) return false;
  if (!/^video\//i.test(file.type)) {
    alert('Please choose a video file (mp4/webm/mov, etc).');
    return false;
  }

  const url = URL.createObjectURL(file);
  const v = sharedPlaylist.createHiddenVideo(url);
  v.muted = true; v.playsInline = true; v.crossOrigin = 'anonymous';
  v.loop = true; // ensure uploaded videos persist without ending

  return new Promise((resolve) => {
    const onReady = () => {
      try { sharedPlaylist.vidEl?.pause?.(); } catch {}
      sharedPlaylist.videoEls = [v];
      sharedPlaylist.activeIdx = 0;
      sharedPlaylist.vidEl = v;
      sharedPlaylist.vidW = v.videoWidth || 1;
      sharedPlaylist.vidH = v.videoHeight || 1;
      sharedPlaylist.loaded = true;
      sharedPlaylist.maskData = null;

      v.currentTime = 0;
      v.play().catch(()=>{});

      if (_customBlobURL && _customBlobURL !== url) {
        setTimeout(() => { try { URL.revokeObjectURL(_customBlobURL); } catch {} }, 500);
      }
      _customBlobURL = url;

      if (_webcamStream) { _webcamStream.getTracks().forEach(t => t.stop()); _webcamStream = null; }

      resolve(true);
    };
    v.addEventListener('loadeddata', onReady, { once: true });
    v.load();
  });
}

// --- helper: try to pick a "front" camera deviceId (mobile) ---
async function pickFrontCameraDeviceId() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videos = devices.filter(d => d.kind === 'videoinput');
    const frontish = videos.find(d => /front|user|face/i.test(d.label || ''));
    if (frontish) return frontish.deviceId;
    return videos[0]?.deviceId || null;
  } catch {
    return null;
  }
}

async function useWebcamAsSource() {
  if (!sharedPlaylist) return false;

  // Desktop: keep your current behavior (no change). Mobile: prefer front cam.
  const mobileConstraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'user' }, // selfie/front camera
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  };
  const desktopConstraints = { audio: false, video: true };

  // 1) Try simple approach first (keeps desktop unchanged)
  try {
    const constraints = isMobileUA ? mobileConstraints : desktopConstraints;
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return await attachStream(stream);
  } catch (e1) {
    console.warn('[webcam] initial getUserMedia failed:', e1);
  }

  // 2) Mobile fallback: explicit deviceId selection if facingMode ignored/failed
  if (isMobileUA) {
    try {
      // tiny permissive call may help populate device labels on some iOS builds
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tmp.getTracks().forEach(t => t.stop());
      } catch {}
      const deviceId = await pickFrontCameraDeviceId();
      if (deviceId) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: { exact: deviceId } }
        });
        return await attachStream(stream);
      }
    } catch (e2) {
      console.warn('[webcam] deviceId fallback failed:', e2);
    }
  }

  alert('Could not start the camera. Check site permissions or try another browser.');
  return false;

  async function attachStream(stream) {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.loop = true;
    v.muted = true;
    v.playsInline = true;   // critical for iOS inline playback
    v.autoplay = true;
    v.srcObject = stream;

    Object.assign(v.style, {
      position: 'fixed', left: '0px', top: '0px',
      width: '1px', height: '1px', opacity: '0.01',
      pointerEvents: 'none', zIndex: '-1'
    });
    document.body.appendChild(v);

    await v.play().catch(()=>{});

    await new Promise(res => {
      if (v.readyState >= 1) res();
      else v.addEventListener('loadedmetadata', () => res(), { once: true });
    });

    try { sharedPlaylist.vidEl?.pause?.(); } catch {}
    sharedPlaylist.videoEls = [v];
    sharedPlaylist.activeIdx = 0;
    sharedPlaylist.vidEl = v;
    sharedPlaylist.vidW = v.videoWidth || 1;
    sharedPlaylist.vidH = v.videoHeight || 1;
    sharedPlaylist.loaded = true;
    sharedPlaylist.maskData = null;

    if (_customBlobURL) {
      setTimeout(() => { try { URL.revokeObjectURL(_customBlobURL); } catch {} }, 500);
      _customBlobURL = null;
    }
    if (_webcamStream) { _webcamStream.getTracks().forEach(t => t.stop()); }
    _webcamStream = stream;

    console.log('[webcam] active track:', stream.getVideoTracks()[0]?.label || '(no label)');
    return true;
  }
}

function restoreDemoPlaylist() {
  if (!sharedPlaylist) return;

  if (_webcamStream) { _webcamStream.getTracks().forEach(t => t.stop()); _webcamStream = null; }

  if (_customBlobURL) {
    setTimeout(() => { try { URL.revokeObjectURL(_customBlobURL); } catch {} }, 500);
    _customBlobURL = null;
  }

  const first = sharedPlaylist.videoEls?.[0];
  if (first && first.srcObject) {
    try { first.pause(); } catch {}
    try { document.body.removeChild(first); } catch {}
  }

  const w = p5Instance?.width || window.innerWidth;
  const h = p5Instance?.height || window.innerHeight;
  sharedPlaylist.dispose();
  sharedPlaylist = new VideoPlaylist({ isMobile: window.innerWidth <= 800 });
  sharedPlaylist.init(w, h);

  if (currentEffect) currentEffect.video = sharedPlaylist;
}

/* =======================
   Dock UI
   ======================= */

function wireDock(joystickCallback) {
  const old = document.getElementById('fx-dock');
  if (old) old.remove();

  const dock = mk('div', {
    position: 'fixed',
    right: '18px',
    bottom: '16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '10px',
    zIndex: '99990',
    pointerEvents: 'auto',
    touchAction: 'none',
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
    boxSizing: 'border-box',
  });
  dock.id = 'fx-dock';

  const forcePE = document.createElement('style');
  forcePE.textContent = `#fx-dock, #fx-dock * { pointer-events: auto !important; touch-action: manipulation; }`;
  document.head.appendChild(forcePE);

  // ---- TINY SOURCE ICONS (subtle) ----
  const tiny = mk('div', {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    padding: '4px 6px',
    background: 'rgba(14,17,26,0.40)',
    border: '1px solid rgba(230,232,240,0.14)',
    borderRadius: '10px',
    opacity: '0.78',
    transition: 'opacity 140ms ease',
  });
  tiny.addEventListener('mouseenter', () => (tiny.style.opacity = '1'));
  tiny.addEventListener('mouseleave', () => (tiny.style.opacity = '0.78'));

  const icoBtn = (label, title) => {
    const b = mk('button', {
      width: '26px', height: '26px', borderRadius: '8px',
      border: '1px solid rgba(230,232,240,0.55)',
      background: 'rgba(230,232,240,0.08)', color: '#e6e8f0',
      fontSize: '13px', lineHeight: '26px',
      cursor: 'pointer', padding: '0',
      transition: 'transform 120ms ease, background 120ms ease, border-color 120ms ease',
    });
    b.textContent = label;
    b.title = title;
    b.addEventListener('mouseenter', () => (b.style.background = 'rgba(230,232,240,0.15)'));
    b.addEventListener('mouseleave', () => (b.style.background = 'rgba(230,232,240,0.08)'));
    b.addEventListener('mousedown', () => (b.style.transform = 'scale(0.95)'));
    b.addEventListener('mouseup',   () => (b.style.transform = 'scale(1)'));
    return b;
  };

  const uploadBtn = icoBtn('📤', 'Upload video (U)');
  const camBtn    = icoBtn('🎥', 'Webcam (W)');
  const demoBtn   = icoBtn('◼︎',  'Demo playlist (D)');

  const fileInput = mk('input', { display: 'none' });
  fileInput.type = 'file';
  fileInput.accept = 'video/*';
  // Mobile hint: use front camera if the user captures from camera UI
  if (isMobileUA) fileInput.setAttribute('capture', 'user');

  uploadBtn.addEventListener('click', (e) => { e.preventDefault(); fileInput.click(); });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    userInteracted = true; stopAutoRotate();
    const ok = await useFileAsSource(f);
    if (ok) flash(tiny, 'Uploaded');
    else alert('Could not load that video. Try a different file.');
    fileInput.value = '';
  });
  camBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    userInteracted = true; stopAutoRotate();
    const ok = await useWebcamAsSource();
    if (ok) flash(tiny, isMobileUA ? 'Front Cam On' : 'Webcam On');
    else alert('Webcam not available. Ensure HTTPS/localhost and allow camera.');
  });
  demoBtn.addEventListener('click', (e) => {
    e.preventDefault();
    userInteracted = true; stopAutoRotate();
    restoreDemoPlaylist();
    flash(tiny, 'Demo');
  });

  tiny.appendChild(uploadBtn);
  tiny.appendChild(camBtn);
  tiny.appendChild(demoBtn);
  tiny.appendChild(fileInput);
  dock.appendChild(tiny);

  // ---- JOYSTICK ----
  const joy = buildJoystick((payload) => {
    if (payload?.active || payload?.mag > 0.12) {
      userInteracted = true;
      stopAutoRotate();
    }
    joystickCallback?.(payload);
  });
  joy.wrapper.style.boxSizing = 'border-box';
  dock.appendChild(joy.wrapper);

  // ---- PREVIEW (thumbnail box) ----
  const preview = mk('div', {
    position: 'relative',
    width: '240px',
    height: '120px',
    borderRadius: '16px',
    overflow: 'hidden',
    background: 'rgba(14,17,26,0.55)',
    backdropFilter: 'blur(6px)',
    border: '1px solid rgba(230,232,240,0.18)',
    boxShadow: '0 2px 12px rgba(0,0,0,0.25)',
    pointerEvents: 'auto',
    boxSizing: 'border-box',
  });
  preview.id = 'fx-preview';
  preview.addEventListener('pointerdown', () => { userInteracted = true; stopAutoRotate(); }, { passive: true });
  preview.addEventListener('touchstart',  () => { userInteracted = true; stopAutoRotate(); }, { passive: true });
  preview.addEventListener('click',       () => { userInteracted = true; stopAutoRotate(); });

  const img = mk('img', {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    opacity: '0.88',
    filter: 'saturate(1.05) contrast(1.02)',
    pointerEvents: 'none',
  });
  img.alt = '';
  img.addEventListener('load', () => requestAnimationFrame(syncDockSizes));
  preview.appendChild(img);

  // ---- DOTS — VIDEO THRESHOLD FIRST ----
  const bar = mk('div', {
    position: 'relative',
    display: 'flex',
    gap: '10px',
    alignItems: 'center',
    padding: '8px 10px',
    background: 'rgba(14,17,26,0.45)',
    backdropFilter: 'blur(6px)',
    borderRadius: '999px',
    border: '1px solid rgba(230,232,240,0.14)',
    pointerEvents: 'auto',
    boxSizing: 'border-box',
    touchAction: 'manipulation',
  });
  bar.id = 'fx-dots';

  const mkDot = (key, titleText) => {
    const d = mk('button', {
      width: '14px', height: '14px', borderRadius: '50%',
      border: '1px solid rgba(230,232,240,0.65)',
      background: 'transparent', padding: '0',
      cursor: 'pointer',
      transition: 'transform 160ms ease, background 160ms ease, border-color 160ms ease, opacity 160ms ease',
      opacity: '0.95', touchAction: 'manipulation',
    });
    d.setAttribute('data-key', key);
    d.title = titleText;
    d.setAttribute('aria-label', titleText);

    const trigger = () => { userInteracted = true; stopAutoRotate(); switchEffect(key); };

    d.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); trigger(); }, { passive: false });
    d.addEventListener('touchstart',  (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    d.addEventListener('touchend',    (e) => { e.preventDefault(); e.stopPropagation(); trigger(); }, { passive: false });
    d.addEventListener('click',       (e) => { e.preventDefault(); e.stopPropagation(); trigger(); });

    d.addEventListener('mouseenter', () => (d.style.opacity = '1'));
    d.addEventListener('mouseleave', () => (d.style.opacity = '0.95'));
    return d;
  };

  const addDot = (k) => bar.appendChild(mkDot(k, EFFECT_META[k]?.title || k));
  addDot('video+threshold');
  addDot('ascii+drips');
  addDot('video+particles');
  addDot('video+bezier');
  addDot('video+mosaic');

  // Assemble
  dock.appendChild(preview);
  dock.appendChild(bar);
  document.body.appendChild(dock);

  // Size binding
  requestAnimationFrame(syncDockSizes);
  const ro = new ResizeObserver(syncDockSizes);
  ro.observe(bar);
  window.addEventListener('resize', syncDockSizes, { passive: true });

  // Init preview image
  updatePreview(currentKey);

  // ---- keyboard shortcuts: U/W/D ----
  const onKey = async (e) => {
    if (e.repeat) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'u') {
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
      const input = dock.querySelector('input[type=file]');
      if (input) input.dispatchEvent(evt);
    } else if (k === 'w') {
      userInteracted = true; stopAutoRotate();
      const ok = await useWebcamAsSource();
      if (ok) flash(tiny, isMobileUA ? 'Front Cam On' : 'Webcam On');
      else alert('Webcam not available. Ensure HTTPS/localhost and allow camera.');
    } else if (k === 'd') {
      userInteracted = true; stopAutoRotate();
      restoreDemoPlaylist();
      flash(tiny, 'Demo');
    }
  };
  window.addEventListener('keydown', onKey);

  // ---- Tap hit-test logger (helps diagnose overlays) ----
  const logTap = (x, y, label) => {
    try {
      const els = document.elementsFromPoint(x, y);
      console.log(`[hit] ${label} @ ${x.toFixed(0)},${y.toFixed(0)}`, els.map(e => e.id || e.className || e.tagName));
    } catch {}
  };
  ['pointerdown','touchstart','click'].forEach(evt => {
    dock.addEventListener(evt, (e) => {
      const t = e.touches?.[0] || e;
      logTap(t.clientX, t.clientY, 'dock');
    }, { passive: true });
  });
}

// Build a draggable joystick that emits normalized axes and snaps back
function buildJoystick(onInput) {
  const WRAP_SIZE = 160;  // initial; syncDockSizes sets to dots width
  const KNOB = 24;        // diameter
  const BORDER = 1;

  const wrapper = mk('div', {
    position: 'relative',
    width: WRAP_SIZE + 'px',
    height: WRAP_SIZE + 'px',
    borderRadius: '16px',
    background: 'rgba(14,17,26,0.55)',
    border: `1px solid rgba(230,232,240,0.18)`,
    backdropFilter: 'blur(6px)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.22)',
    overflow: 'hidden',
    pointerEvents: 'auto',
    touchAction: 'none',
    boxSizing: 'border-box',
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
  });
  wrapper.id = 'fx-joystick';

  // Crosshair
  ['H','V'].forEach(axis => {
    const g = mk('div', { position: 'absolute', pointerEvents: 'none', background: 'rgba(230,232,240,0.15)' });
    if (axis === 'H') Object.assign(g.style, { left: 0, right: 0, top: '50%', height: '1px', transform: 'translateY(-0.5px)' });
    else              Object.assign(g.style, { top: 0, bottom: 0, left: '50%', width: '1px', transform: 'translateX(-0.5px)' });
    wrapper.appendChild(g);
  });

  // Knob (centered default)
  const knob = mk('div', {
    position: 'absolute',
    width: KNOB + 'px',
    height: KNOB + 'px',
    borderRadius: '50%',
    background: 'rgba(230,232,240,0.9)',
    border: '1px solid rgba(230,232,240,0.7)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25), inset 0 0 6px rgba(255,255,255,0.35)',
    left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
    transition: 'transform 180ms ease', willChange: 'transform',
    cursor: 'grab', touchAction: 'none', zIndex: '1',
  });
  wrapper.appendChild(knob);

  let dragging = false;

  function emit(dx, dy, active) {
    const rect = wrapper.getBoundingClientRect();
    const halfW = rect.width / 2;
    const halfH = rect.height / 2;
    const r = KNOB / 2 + BORDER;

    const maxX = halfW - r;
    const maxY = halfH - r;

    const nx = clamp(dx / maxX, -1, 1);
    const ny = clamp(dy / maxY, -1, 1);

    const mag = clamp(Math.hypot(nx, ny), 0, 1);

    let dir = 'center';
    const dead = 0.2;
    if (mag >= dead) {
      if (Math.abs(nx) > Math.abs(ny)) dir = nx > 0 ? 'right' : 'left';
      else dir = ny > 0 ? 'down' : 'up';
    }

    onInput?.({ x: nx, y: ny, mag, dir, active });
  }

  function setKnobFromPointer(clientX, clientY) {
    const rect = wrapper.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    let dx = clientX - cx;
    let dy = clientY - cy;

    const r = KNOB / 2 + BORDER;
    const maxX = rect.width / 2 - r;
    const maxY = rect.height / 2 - r;
    dx = Math.max(-maxX, Math.min(dx, maxX));
    dy = Math.max(-maxY, Math.min(dy, maxY));

    knob.style.transition = 'none';
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    emit(dx, dy, true);
  }

  function centerKnob() {
    knob.style.transition = 'transform 180ms ease';
    knob.style.transform = `translate(-50%, -50%)`;
    emit(0, 0, false);
  }

  function startDrag(clientX, clientY) {
    dragging = true;
    knob.style.cursor = 'grabbing';
    setKnobFromPointer(clientX, clientY);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { passive: true, once: true });
    window.addEventListener('pointercancel', onUp, { passive: true, once: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp, { passive: true, once: true });
    window.addEventListener('touchcancel', onUp, { passive: true, once: true });
  }

  function onDown(e) {
    e.preventDefault();
    const t = e.touches?.[0];
    startDrag(t ? t.clientX : e.clientX, t ? t.clientY : e.clientY);
  }

  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const t = e.touches?.[0];
    setKnobFromPointer(t ? t.clientX : e.clientX, t ? t.clientY : e.clientY);
  }

  function onUp() {
    dragging = false;
    knob.style.cursor = 'grab';
    centerKnob();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('touchmove', onMove);
  }

  wrapper.addEventListener('pointerdown', onDown, { passive: false });
  wrapper.addEventListener('touchstart',  onDown, { passive: false });
  knob.addEventListener('pointerdown', onDown, { passive: false });
  knob.addEventListener('touchstart',  onDown, { passive: false });

  return { wrapper, knob, centerKnob };
}

/* =======================
   Joystick dispatcher
   ======================= */

function onJoystickInput(payload) {
  currentEffect?.onJoystick?.(payload);
}

/* =======================
   Dock sizing + preview + dots
   ======================= */

function syncDockSizes() {
  const bar = document.getElementById('fx-dots');
  const preview = document.getElementById('fx-preview');
  const joyWrap = document.getElementById('fx-joystick');
  if (!bar) return;

  const w = bar.offsetWidth; // rendered width incl. borders/padding
  if (w <= 0) return;

  if (preview) {
    preview.style.width = w + 'px';
    const h = Math.max(1, bar.offsetHeight * 2);
    preview.style.height = h + 'px';
  }
  if (joyWrap) {
    joyWrap.style.width = w + 'px';
    joyWrap.style.height = w + 'px'; // square
  }
}

function setActiveDot(key) {
  const bar = document.getElementById('fx-dots');
  if (bar) {
    [...bar.children].forEach((btn) => {
      const active = btn.getAttribute('data-key') === key;
      btn.style.background   = active ? '#e6e8f0' : 'transparent';
      btn.style.borderColor  = active ? '#e6e8f0' : 'rgba(230,232,240,0.55)';
      btn.style.transform    = active ? 'scale(1.25)' : 'scale(1.0)';
      btn.style.opacity      = active ? '1' : '0.95';
    });
  }
  updatePreview(key);
  requestAnimationFrame(syncDockSizes);
}

function updatePreview(key) {
  const meta = EFFECT_META[key] || {};
  const preview = document.getElementById('fx-preview');
  if (preview) {
    const img = preview.querySelector('img');
    if (img) {
      if (meta.thumb) {
        img.src = meta.thumb;
        img.style.background = 'none';
      } else {
        img.removeAttribute('src');
        img.style.background = 'linear-gradient(135deg, #1b1f2a 0%, #0e111a 100%)';
      }
    }
  }
}

/* =======================
   Start
   ======================= */
boot();
