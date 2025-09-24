// app.js — viewport-locked canvas, storm joystick, preview, 5-dot dock
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
  currentKey = effectKey;
  // FALLBACK TO VIDEO THRESHOLD
  const make = EFFECTS[effectKey] || EFFECTS['video+threshold'];
  currentEffect = make({ playlist: sharedPlaylist });

  // eslint-disable-next-line no-undef
  p5Instance = new p5((p) => {
    let lastMs = 0;

    p.preload = () => currentEffect.preload?.(p);

    p.setup = () => {
      lockViewportNoScroll();

      p.pixelDensity(1);
      p.createCanvas(1, 1);
      sizeCanvasToViewport(p);
      p.textAlign(p.CENTER, p.CENTER);

      if (!sharedPlaylist) {
        const isMobile = p.windowWidth <= 800;
        sharedPlaylist = new VideoPlaylist({ isMobile });
        sharedPlaylist.init(p.width, p.height);
      } else {
        sharedPlaylist.resize(p.width, p.height);
      }

      if (currentEffect && !currentEffect.video) currentEffect.video = sharedPlaylist;
      currentEffect.setup?.(p);

      wireDock(onJoystickInput);   // build joystick + preview + dots; subscribe to joystick
      setActiveDot(effectKey);     // highlight dot + set preview
      syncDockSizes();             // match widths exactly

      // kick off auto-rotation (only once)
      startAutoRotate();
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
    };
  });
}

function switchEffect(key) {
  if (!EFFECTS[key]) return;

  if (currentEffect && typeof currentEffect.dispose === 'function') {
    if (currentEffect._ownsVideo) currentEffect.dispose();
    else currentEffect.dispose({ keepVideo: true });
  }

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
   Dock UI (joystick + preview + dots)
   ======================= */

function wireDock(joystickCallback) {
  // Remove any previous dock to avoid double overlays after hot reloads/partial loads
  const old = document.getElementById('fx-dock');
  if (old) old.remove();

  const dock = document.createElement('div');
  dock.id = 'fx-dock';
  Object.assign(dock.style, {
    position: 'fixed',
    right: '18px',
    bottom: '16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '10px',
    // Make it unquestionably clickable on mobile:
    zIndex: '99990',              // below nav (100000), above anything else
    pointerEvents: 'auto',
    touchAction: 'none',
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
  });

  // Hard-block any ancestor pointer-events weirdness:
  dock.setAttribute('data-hitfix', '1');
  dock.style.pointerEvents = 'auto';
  // ensure children are active too
  const forcePE = document.createElement('style');
  forcePE.textContent = `
    #fx-dock, #fx-dock * { pointer-events: auto !important; touch-action: manipulation; }
  `;
  document.head.appendChild(forcePE);

  // JOYSTICK
  const joy = buildJoystick((payload) => {
    if (payload?.active || payload?.mag > 0.12) {
      userInteracted = true;
      stopAutoRotate();
    }
    joystickCallback?.(payload);
  });
  joy.wrapper.style.boxSizing = 'border-box';
  dock.appendChild(joy.wrapper);

  // PREVIEW (thumbnail box)
  const preview = document.createElement('div');
  preview.id = 'fx-preview';
  Object.assign(preview.style, {
    position: 'relative',
    width: '240px',   // placeholder; syncDockSizes will override
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
  // tap on preview counts as interaction (stops shuffle)
  preview.addEventListener('pointerdown', () => { userInteracted = true; stopAutoRotate(); }, { passive: true });
  preview.addEventListener('touchstart',  () => { userInteracted = true; stopAutoRotate(); }, { passive: true });
  preview.addEventListener('click',       () => { userInteracted = true; stopAutoRotate(); });

  const img = document.createElement('img');
  img.alt = '';
  Object.assign(img.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    opacity: '0.88',
    filter: 'saturate(1.05) contrast(1.02)',
    pointerEvents: 'none', // the image itself shouldn’t steal events
  });
  img.addEventListener('load', () => requestAnimationFrame(syncDockSizes));
  preview.appendChild(img);

  // DOTS — VIDEO THRESHOLD FIRST
  const bar = document.createElement('div');
  bar.id = 'fx-dots';
  Object.assign(bar.style, {
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

  const mkDot = (key, titleText) => {
    const d = document.createElement('button');
    d.setAttribute('data-key', key);
    d.title = titleText;
    d.setAttribute('aria-label', titleText);
    Object.assign(d.style, {
      width: '14px',
      height: '14px',
      borderRadius: '50%',
      border: '1px solid rgba(230,232,240,0.65)',
      background: 'transparent',
      padding: '0',
      cursor: 'pointer',
      transition: 'transform 160ms ease, background 160ms ease, border-color 160ms ease, opacity 160ms ease',
      opacity: '0.95',
      touchAction: 'manipulation',
    });

    const trigger = () => {
      userInteracted = true;
      stopAutoRotate();
      switchEffect(key);
    };

    // Mobile-first: pointerdown + touchend (some browsers suppress click)
    d.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); trigger(); }, { passive: false });
    d.addEventListener('touchstart',  (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    d.addEventListener('touchend',    (e) => { e.preventDefault(); e.stopPropagation(); trigger(); }, { passive: false });
    // Desktop fallback
    d.addEventListener('click',       (e) => { e.preventDefault(); e.stopPropagation(); trigger(); });

    d.addEventListener('mouseenter', () => (d.style.opacity = '1'));
    d.addEventListener('mouseleave', () => (d.style.opacity = '0.95'));
    return d;
  };

  const add = (k) => bar.appendChild(mkDot(k, EFFECT_META[k]?.title || k));
  // ORDER CHANGED: video+threshold first, then ascii
  add('video+threshold');
  add('ascii+drips');
  add('video+particles');
  add('video+bezier');
  add('video+mosaic');

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

  const wrapper = document.createElement('div');
  wrapper.id = 'fx-joystick';
  Object.assign(wrapper.style, {
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

  // Crosshair
  ['H','V'].forEach(axis => {
    const g = document.createElement('div');
    if (axis === 'H') Object.assign(g.style, {
      position: 'absolute', left: 0, right: 0, top: '50%',
      height: '1px', background: 'rgba(230,232,240,0.15)',
      transform: 'translateY(-0.5px)',
      pointerEvents: 'none',
    });
    else Object.assign(g.style, {
      position: 'absolute', top: 0, bottom: 0, left: '50%',
      width: '1px', background: 'rgba(230,232,240,0.15)',
      transform: 'translateX(-0.5px)',
      pointerEvents: 'none',
    });
    wrapper.appendChild(g);
  });

  // Knob (centered default)
  const knob = document.createElement('div');
  Object.assign(knob.style, {
    position: 'absolute',
    width: KNOB + 'px',
    height: KNOB + 'px',
    borderRadius: '50%',
    background: 'rgba(230,232,240,0.9)',
    border: '1px solid rgba(230,232,240,0.7)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25), inset 0 0 6px rgba(255,255,255,0.35)',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    transition: 'transform 180ms ease',
    willChange: 'transform',
    cursor: 'grab',
    touchAction: 'none',
    zIndex: '1',
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

  // start drag from anywhere on the pad (mobile-friendly)
  wrapper.addEventListener('pointerdown', onDown, { passive: false });
  wrapper.addEventListener('touchstart',  onDown, { passive: false });
  // keep knob listeners
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
   Utilities
   ======================= */
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

/* =======================
   Start
   ======================= */
boot();
