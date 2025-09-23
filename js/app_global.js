// /js/app_global.js — p5 GLOBAL mode bootstrap + effect switcher
// ASCII stays untouched. Brush runs in WEBGL.
// Your existing class files (ascii.js, etc.) keep their APIs.

import { AsciiSilhouetteEffect } from './ascii.js';
import { VideoBrushEffect } from './videobrush.js'; // new file below

// Register effects
const EFFECTS = {
  'ascii+drips': () => new AsciiSilhouetteEffect(),
  'video+brush': () => new VideoBrushEffect(),
};

// Which effects want WEBGL?
const EFFECT_RENDERER = {
  'ascii+drips': 'P2D',
  'video+brush': 'WEBGL',
};

let currentEffect = null;
let activeKey = null;
let lastMs = 0;

// Minimal "p" proxy so your class code can keep calling p.* methods/properties
function makePProxy() {
  const g = window;
  const p = {};
  Object.defineProperties(p, {
    width:        { get: () => g.width },
    height:       { get: () => g.height },
    windowWidth:  { get: () => g.windowWidth },
    windowHeight: { get: () => g.windowHeight },
    millis:       { get: () => g.millis },
    _renderer:    { get: () => ({ elt: document.querySelector('canvas') }) },
    canvas:       { get: () => document.querySelector('canvas') },
  });
  [
    'createGraphics','loadImage','loadFont','image','tint','push','pop',
    'noStroke','stroke','strokeWeight','fill','rect','circle','colorMode',
    'textAlign','textFont','textSize','random','background','color','translate',
    'blendMode','imageMode'
  ].forEach(fn => { p[fn] = (...args) => g[fn](...args); });
  p.RGB = window.RGB; p.HSL = window.HSL;
  p.CENTER = window.CENTER; p.CORNER = window.CORNER;
  p.ADD = window.ADD; p.BLEND = window.BLEND;
  return p;
}
const pProxy = makePProxy();

function initialEffectKey() {
  const q = new URLSearchParams(window.location.search).get('fx');
  if (q && EFFECTS[q]) return q;
  const h = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('fx');
  if (h && EFFECTS[h]) return h;

  const sel = document.getElementById('fx-select');
  if (sel && sel.value && EFFECTS[sel.value]) return sel.value;
  if (sel && sel.dataset.default && EFFECTS[sel.dataset.default]) return sel.dataset.default;

  return 'ascii+drips'; // keep ASCII as default
}
function setEffect(key) {
  const create = EFFECTS[key] || EFFECTS['ascii+drips'];
  currentEffect = create();
  activeKey = key;
}
function wirePanel() {
  const sel = document.getElementById('fx-select');
  if (!sel || sel.dataset.bound) return;
  Object.keys(EFFECTS).forEach((k) => {
    if (![...sel.options].some(o => o.value === k)) {
      const opt = document.createElement('option');
      opt.value = k; opt.textContent = k;
      sel.appendChild(opt);
    }
  });
  sel.dataset.bound = '1';
  sel.addEventListener('change', () => switchEffect(sel.value));
  if (!sel.value) sel.value = activeKey || 'ascii+drips';
}
function switchEffect(key) {
  currentEffect?.dispose?.(pProxy);

  // Recreate canvas with desired renderer
  const wantsWebGL = EFFECT_RENDERER[key] === 'WEBGL';
  const old = document.querySelector('canvas'); if (old) old.remove();
  createCanvas(window.innerWidth, window.innerHeight, wantsWebGL ? WEBGL : P2D);
  pixelDensity(1);
  textAlign(CENTER, CENTER);

  setEffect(key);
  currentEffect.preload?.(pProxy);
  currentEffect.setup?.(pProxy);
  wirePanel();
}

// ---------------- p5 GLOBAL callbacks ----------------
window.preload = function () {
  setEffect(initialEffectKey());
  currentEffect.preload?.(pProxy);
};
window.setup = function () {
  const wantsWebGL = EFFECT_RENDERER[activeKey] === 'WEBGL';
  createCanvas(window.innerWidth, window.innerHeight, wantsWebGL ? WEBGL : P2D);
  pixelDensity(1);
  textAlign(CENTER, CENTER);
  currentEffect.setup?.(pProxy);
  wirePanel();
};
window.windowResized = function () {
  resizeCanvas(window.innerWidth, window.innerHeight);
  currentEffect.resize?.(pProxy);
};
window.draw = function () {
  const now = millis();
  const dt = lastMs ? (now - lastMs) : 16.7; lastMs = now;
  currentEffect.update?.(pProxy, dt);
  currentEffect.draw?.(pProxy);
};

// allow manual switching via console: __switchEffect('video+brush')
window.__switchEffect = switchEffect;
