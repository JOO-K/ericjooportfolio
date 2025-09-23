/**************************************************
 * Yarndings — drips on click, VIDEO-driven ASCII silhouette
 * - Dark background
 * - Responsive GRID (<=800px → 8px tiles; else 20px)
 * - Characters shuffle every ~0.2s (time-based)
 * - Temporal ASCII blur (offscreen layer)
 * - Playlist:
 *    Desktop → /videos/horse2.mp4 → /videos/dog.mp4 → /videos/cat.mp4 (preloaded & looped)
 *    Mobile  → /videos/mobile.mp4 (looped)
 * - No hover enlarge; no in-canvas UI placeholders
 **************************************************/

/* ---------- visuals + grid ---------- */
let GRID = 20;                        // dynamic (set in initGrid by width)
const BG_COLOR = '#0e111a';           // dark
const BG_RGB = hexToRgb(BG_COLOR);

/* ---------- VIDEO silhouette ---------- */
const DESKTOP_PLAYLIST = [
  { label: 'horse', sources: ['/videos/tree.mp4', '/videos/horse2.webm'] },
  { label: 'dog',   sources: ['/videos/dog.mp4'] },
  { label: 'cat',   sources: ['/videos/cat.mp4'] },
];
const MOBILE_PLAYLIST  = [
  { label: 'mobile', sources: ['/videos/mobile.mp4'] },
];

const SIL_BRIGHTNESS_THRESHOLD = 170; // higher = thicker silhouette
const SIL_SCALE = 0.88;               // < 1.0 → margin from edges (centered)

/* Throttle video sampling: update 2 frames, skip 1 (~33% fewer updates) */
const VIDEO_UPDATE_PERIOD = 3;  // cycle length
const VIDEO_UPDATE_ACTIVE = 2;  // frames per cycle to update
let videoUpdateCounter = 0;

/* ---------- ASCII trail fade (temporal blur) ---------- */
const ASCII_FADE_TAU_MS = 100;        // Smaller = faster fade

/* ---------- character shuffle cadence ---------- */
const CHAR_REFRESH_MS = 2500;  // ~0.2 seconds between character shuffles
let lastCharRefreshAt = 0;
let charTick = 0;

/* ---------- drip motion ---------- */
const STEP_MS_MIN = 60;
const STEP_MS_MAX = 120;
const MAX_STEPS_PER_UPDATE = 6;
const START_ROW_MIN = -8;

/* ---------- fading of image drips ---------- */
const SEGMENT_FADE_MS = 1200;
const SEGMENT_FADE_DELAY_FACTOR = 0.50;
const FINAL_FADE_DELAY_MS = 200;
const FINAL_FADE_MS = 600;

/* ---------- spawn (click/tap) ---------- */
const CLICK_SPAWN_COUNT = 2;
const CLICK_SCATTER_COLS = 1;

/* ---------- background characters ---------- */
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@$%&*+•◦=<>/^~░▒▓█";

/* ---------- assets (images for drops) ---------- */
const HP_PATH_PREFIX = 'images/hp_';
const HP_PATH_SUFFIX = '.png';
const HP_TRY_COUNT   = 120;

/* ---------- growth profile for drips ---------- */
const MAX_SIZE   = 9;
const GROWTH_START = 0.00;
const GROWTH_EASE  = 0.7;

/* ---------- state ---------- */
let fontYarn, IMAGES = [];
let p5Canvas, cols = 0, rows = 0;
let pX = -9999, pY = -9999;
let occ = [];
let nextId = 1;
const drips = [];

let cellHSL = [];        // stable colors per cell

/* ---------- video playlist manager ---------- */
let videoEls = [];       // HTMLVideoElements in playlist order
let activeVidIdx = 0;
let vidEl = null;
let vidLoaded = false, vidW = 1, vidH = 1;

/* ---------- offscreen mask & ASCII layer ---------- */
let maskCanvas, maskCtx, maskData = null;
let asciiLayer;

/* =======================================================
   p5 lifecycle
======================================================= */
function preload() {
  fontYarn = loadFont('fonts/Yarndings20-Regular.ttf', () => {}, () => {});
  for (let i = 1; i <= HP_TRY_COUNT; i++) {
    loadImage(`${HP_PATH_PREFIX}${i}${HP_PATH_SUFFIX}`,
      img => IMAGES.push(img), () => {});
  }
}

function setup() {
  pixelDensity(1);
  p5Canvas = createCanvas(windowWidth, windowHeight);
  background(BG_COLOR);
  textAlign(CENTER, CENTER);
  if (fontYarn) textFont(fontYarn);

  // offscreen mask canvas (for sampling video)
  maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  maskCtx.imageSmoothingEnabled = false;

  // offscreen ASCII layer (we fade this each frame → motion blur)
  asciiLayer = createGraphics(width, height);
  asciiLayer.textAlign(CENTER, CENTER);
  if (fontYarn) asciiLayer.textFont(fontYarn);
  asciiLayer.noStroke();

  // Build the playlist based on initial viewport (mobile vs desktop)
  const isMobile = windowWidth <= 800;
  initVideoPlaylist(isMobile ? MOBILE_PLAYLIST : DESKTOP_PLAYLIST);

  initGrid();

  // pointer tracking
  const updatePointer = (x, y) => {
    const r = p5Canvas.elt.getBoundingClientRect();
    const sx = width  / r.width;
    const sy = height / r.height;
    pX = (x - r.left) * sx;
    pY = (y - r.top)  * sy;
  };
  p5Canvas.elt.addEventListener('pointermove', e => updatePointer(e.clientX, e.clientY), { passive: true });
  p5Canvas.elt.addEventListener('pointerenter', e => updatePointer(e.clientX, e.clientY), { passive: true });
  p5Canvas.elt.addEventListener('pointerleave', () => { pX = pY = -9999; }, { passive: true });

  // click/tap spawns drips
  p5Canvas.elt.addEventListener('pointerdown', e => {
    updatePointer(e.clientX, e.clientY);
    spawnDripsAtPointer();
  });
  p5Canvas.elt.addEventListener('touchstart', e => {
    const t = e.touches[0];
    if (t) updatePointer(t.clientX, t.clientY);
    spawnDripsAtPointer();
  }, { passive: true });
  p5Canvas.elt.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (t) updatePointer(t.clientX, t.clientY);
  }, { passive: true });
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);

  // resize offscreen mask too
  maskCanvas.width = width;
  maskCanvas.height = height;
  maskCtx.imageSmoothingEnabled = false;

  // recreate ASCII layer at new size
  asciiLayer = createGraphics(width, height);
  asciiLayer.textAlign(CENTER, CENTER);
  if (fontYarn) asciiLayer.textFont(fontYarn);
  asciiLayer.noStroke();

  initGrid();
  background(BG_COLOR);
}

/* =======================================================
   Video playlist loader
   - For the first video: wait for loadeddata, play it, then preload rest.
   - Each element listens for 'ended' to chain to the next.
======================================================= */
function createHiddenVideo(sources) {
  const v = document.createElement('video');
  v.preload = 'auto';
  v.loop = false;            // chain manually
  v.muted = true;
  v.playsInline = true;
  v.autoplay = false;        // start only when active
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

function initVideoPlaylist(list) {
  if (!list || !list.length) return;

  // Create & start first video (horse or mobile)
  const first = createHiddenVideo(list[0].sources);
  videoEls[0] = first;

  const onFirstReady = () => {
    activeVidIdx = 0;
    vidEl = first;
    vidW = vidEl.videoWidth || 1;
    vidH = vidEl.videoHeight || 1;
    vidLoaded = true;

    vidEl.currentTime = 0;
    vidEl.play().catch(()=>{});
    vidEl.addEventListener('ended', switchToNextVideo);

    // Preload remaining videos (if any) to avoid latency on switch
    for (let i = 1; i < list.length; i++) {
      const v = createHiddenVideo(list[i].sources);
      videoEls[i] = v;
      v.load();
      v.addEventListener('canplaythrough', () => {}, { once: true });
      v.addEventListener('ended', switchToNextVideo);
    }
  };

  first.addEventListener('loadeddata', onFirstReady, { once: true });
  first.load();
}

function switchToNextVideo() {
  if (!videoEls.length) return;

  try { vidEl.pause(); } catch(_) {}

  activeVidIdx = (activeVidIdx + 1) % videoEls.length;
  vidEl = videoEls[activeVidIdx];

  if (vidEl.readyState < 1) {
    vidEl.addEventListener('loadeddata', () => {
      vidW = vidEl.videoWidth || 1;
      vidH = vidEl.videoHeight || 1;
    }, { once: true });
  } else {
    vidW = vidEl.videoWidth || 1;
    vidH = vidEl.videoHeight || 1;
  }

  maskData = null;
  vidLoaded = true;
  vidEl.currentTime = 0;
  vidEl.play().catch(()=>{});
}

/* =======================================================
   Grid / background setup
======================================================= */
function initGrid() {
  // responsive GRID
  GRID = (windowWidth <= 800) ? 8 : 20;

  cols = floor(width / GRID);
  rows = floor(height / GRID);

  // random HSL per cell (stable until reset)
  cellHSL = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => {
      const h = floor(random(0, 360));
      const s = 40 + floor(random(0, 50));
      const l = 35 + floor(random(0, 40));
      return { h, s, l };
    })
  );

  // image occupancy (for non-overlap)
  occ = Array.from({ length: rows }, () => Array(cols).fill(null));

  drips.length = 0;
}

/* =======================================================
   helpers
======================================================= */
function hexToRgb(hex) {
  let h = hex.replace('#','').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function hashCell(x, y) {
  const s = sin((x + 13.37) * (y + 7.77));
  return abs(s * 43758.5453) % 1;
}
function charForFrame(gx, gy, tick) {
  // deterministic but changes only when charTick increments
  const r = hashCell(gx * 123.45 + gy * 987.65 + tick * 0.777, gy * 456.78 + tick * 1.234);
  const idx = floor(r * CHARSET.length) % CHARSET.length;
  return CHARSET.charAt(idx);
}
function imageAt(col, row) {
  if (!IMAGES.length) return null;
  const idx = floor(hashCell(col + 222, row + 444) * IMAGES.length);
  return IMAGES[idx % IMAGES.length];
}
function drawImageCover(img, x, y, w, h, alpha = 255) {
  if (!img) return;
  const iw = img.width, ih = img.height; if (!iw || !ih) return;
  const rBox = w / h, rImg = iw / ih;
  let dw, dh; if (rImg > rBox) { dh = h; dw = rImg * dh; } else { dw = w; dh = dw / rImg; }
  push(); tint(255, alpha); image(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); pop();
}

/* ---------- occupancy (images only) ---------- */
function canPlaceRect(c, r, w, h) {
  if (c < 0 || c + w > cols) return false;
  const r0 = max(0, r), r1 = min(rows, r + h);
  for (let y = r0; y < r1; y++) for (let x = c; x < c + w; x++) if (occ[y][x] !== null) return false;
  return true;
}
function placeRect(id, c, r, w, h) {
  const r0 = max(0, r), r1 = min(rows, r + h);
  for (let y = r0; y < r1; y++) for (let x = c; x < c + w; x++) occ[y][x] = id;
}
function freeRectById(id, c, r, w, h) {
  const r0 = max(0, r), r1 = min(rows, r + h);
  for (let y = r0; y < r1; y++) for (let x = c; x < c + w; x++) if (occ[y][x] === id) occ[y][x] = null;
}

/* =======================================================
   Drip growth (front-loaded 1→9; +1 max per step)
======================================================= */
function sizeFromProgress(progress, prevSize) {
  const prev = prevSize || 1;
  if (progress <= GROWTH_START) return { w: prev, h: prev };
  const p = (progress - GROWTH_START) / (1 - GROWTH_START);
  const eased = pow(constrain(p, 0, 1), GROWTH_EASE);
  let s = 1 + floor(eased * (MAX_SIZE - 1) + 1e-6);
  s = max(prev, min(prev + 1, s));
  s = constrain(s, 1, min(MAX_SIZE, cols, rows));
  return { w: s, h: s };
}

/* ---------- final placement ON THE FLOOR (no overlaps) ---------- */
function finalBottomPlacement(prev) {
  const prevL = prev.c, prevR = prev.c + prev.w - 1;
  for (let s = min(MAX_SIZE, cols, rows); s >= 1; s--) {
    let minC = max(0, prevL - (s - 1));
    let maxC = min(cols - s, prevR);
    if (minC > maxC) continue;
    const r = rows - s;
    for (let tries = 10; tries-- > 0;) { const c = floor(random(minC, maxC + 1)); if (canPlaceRect(c, r, s, s)) return { c, r, w: s, h: s }; }
    for (let c = minC; c <= maxC; c++) if (canPlaceRect(c, r, s, s)) return { c, r, w: s, h: s };
  }
  return null;
}

/* =======================================================
   TrailDrip: discrete touching segments, non-overlapping
======================================================= */
class TrailDrip {
  constructor(startCol, startRowFromPointer) {
    this.id = nextId++;
    this.segments = [];   // {c,r,w,h,img,born,_freedOcc?}
    this.finished = false;
    this.finishAt = null;
    this.nextStepAt = millis();

    const r0 = constrain(startRowFromPointer, START_ROW_MIN, rows - 1);
    const c0 = constrain(startCol, 0, cols - 1);
    const seg = { c: c0, r: r0, w: 1, h: 1, img: imageAt(c0, r0), born: millis(), _freedOcc:false };
    this.segments.push(seg);
    placeRect(this.id, seg.c, seg.r, seg.w, seg.h);
  }

  _progressFor(prev) {
    const bottomRow = prev.r + prev.h;
    return constrain(bottomRow / rows, 0, 1);
  }

  _tryNextSegment(prev) {
    const progress = this._progressFor(prev);
    const pick = sizeFromProgress(progress, prev.w);
    const newRow = prev.r + prev.h;

    for (let s = pick.w; s >= 1; s--) {
      const prevL = prev.c, prevR = prev.c + prev.w - 1;
      let minC = max(0, prevL - (s - 1));
      let maxC = min(cols - s, prevR);
      if (minC > maxC) continue;

      for (let tries = 10; tries-- > 0; ) {
        const c = floor(random(minC, maxC + 1));
        if (canPlaceRect(c, newRow, s, s)) return { c, r: newRow, w: s, h: s };
      }
      for (let c = minC; c <= maxC; c++) if (canPlaceRect(c, newRow, s, s)) return { c, r: newRow, w: s, h: s };
    }
    return null;
  }

  _stepOnce() {
    if (this.finished) return;

    const prev = this.segments[this.segments.length - 1];
    let next = this._tryNextSegment(prev);

    if (!next) {
      const finalSeg = finalBottomPlacement(prev);
      if (finalSeg) {
        finalSeg.img = imageAt(finalSeg.c, finalSeg.r);
        finalSeg.born = millis();
        finalSeg._freedOcc = false;
        this.segments.push(finalSeg);
        placeRect(this.id, finalSeg.c, finalSeg.r, finalSeg.w, finalSeg.h);
        this.finished = true;
        this.finishAt = millis();
      } else {
        this.nextStepAt = millis() + 120;
      }
      return;
    }

    if (next.r + next.h >= rows) {
      next.r = rows - next.h;
      const finalSeg = finalBottomPlacement(prev);
      if (finalSeg) {
        finalSeg.img = imageAt(finalSeg.c, finalSeg.r);
        finalSeg.born = millis();
        finalSeg._freedOcc = false;
        this.segments.push(finalSeg);
        placeRect(this.id, finalSeg.c, finalSeg.r, finalSeg.w, finalSeg.h);
        this.finished = true;
        this.finishAt = millis();
      } else {
        this.nextStepAt = millis() + 120;
      }
      return;
    }

    next.img = imageAt(next.c, next.r);
    next.born = millis();
    next._freedOcc = false;
    this.segments.push(next);
    placeRect(this.id, next.c, next.r, next.w, next.h);
  }

  update() {
    if (this.finished) return;
    const now = millis();
    let safety = MAX_STEPS_PER_UPDATE;
    while (now >= this.nextStepAt && safety-- > 0) {
      this._stepOnce();
      this.nextStepAt += random(STEP_MS_MIN, STEP_MS_MAX);
      if (this.finished) break;
    }
  }

  draw() {
    const now = millis();
    const lastIndex = this.segments.length - 1;

    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      let alpha = 255;

      if (!this.finished) {
        alpha = 255;
      } else {
        if (i < lastIndex) {
          const lived = this.finishAt - s.born;
          const delay = lived * SEGMENT_FADE_DELAY_FACTOR;
          const startFade = this.finishAt + delay;
          if (now > startFade) {
            const k = (now - startFade) / SEGMENT_FADE_MS;
            alpha = constrain(255 * (1 - k), 0, 255);
          }
          if (alpha <= 0 && !s._freedOcc) { freeRectById(this.id, s.c, s.r, s.w, s.h); s._freedOcc = true; continue; }
          if (alpha <= 0) continue;
        } else {
          const hold = FINAL_FADE_DELAY_MS;
          if (now > this.finishAt + hold) {
            const k = (now - (this.finishAt + hold)) / FINAL_FADE_MS;
            alpha = constrain(255 * (1 - k), 0, 255);
            if (alpha <= 0 && !s._freedOcc) { freeRectById(this.id, s.c, s.r, s.w, s.h); s._freedOcc = true; continue; }
            if (alpha <= 0) continue;
          }
        }
      }

      drawImageCover(s.img, s.c * GRID, s.r * GRID, s.w * GRID, s.h * GRID, alpha);
    }
  }

  isDone() {
    if (!this.finished) return false;
    const now = millis();
    const finalGone = now > this.finishAt + FINAL_FADE_DELAY_MS + FINAL_FADE_MS;
    if (!finalGone) return false;

    for (let i = 0; i < this.segments.length - 1; i++) {
      const seg = this.segments[i];
      const lived = this.finishAt - seg.born;
      const delay = lived * SEGMENT_FADE_DELAY_FACTOR;
      const startFade = this.finishAt + delay;
      if (now < startFade + SEGMENT_FADE_MS) return false;
    }
    return true;
  }
}

/* =======================================================
   Spawning (click / tap)
======================================================= */
function spawnDripsAtPointer() {
  if (!(pX >= 0 && pY >= 0 && pX <= width && pY <= height)) return;
  const baseCol = constrain(floor(pX / GRID), 0, cols - 1);
  const baseRow = floor(pY / GRID) - 1;
  for (let i = 0; i < CLICK_SPAWN_COUNT; i++) {
    const c = constrain(baseCol + floor(random(-CLICK_SCATTER_COLS, CLICK_SCATTER_COLS + 1)), 0, cols - 1);
    drips.push(new TrailDrip(c, baseRow));
  }
}

/* =======================================================
   VIDEO silhouette helpers (centered & scaled down)
======================================================= */
function updateSilhouetteMask() {
  // throttle video sampling by ~33%
  const doUpdate = (videoUpdateCounter % VIDEO_UPDATE_PERIOD) < VIDEO_UPDATE_ACTIVE;
  videoUpdateCounter = (videoUpdateCounter + 1) % VIDEO_UPDATE_PERIOD;

  if (!doUpdate && maskData) return; // hold previous mask this frame

  maskCtx.clearRect(0, 0, width, height);
  if (!vidLoaded || !vidEl) { maskData = null; return; }

  // compute "contain" rect with extra shrink via SIL_SCALE
  const baseScale = Math.min(width / vidW, height / vidH);
  const scale = baseScale * SIL_SCALE;
  const dw = vidW * scale;
  const dh = vidH * scale;
  const dx = (width - dw) * 0.5;
  const dy = (height - dh) * 0.5;

  maskCtx.drawImage(vidEl, dx, dy, dw, dh);

  try {
    const imgData = maskCtx.getImageData(0, 0, width, height);
    maskData = imgData.data;
  } catch {
    maskData = null;
  }
}

function isSilhouetteAt(px, py) {
  if (!maskData) return false;
  const x = (px | 0), y = (py | 0);
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const idx = (y * width + x) << 2;
  const a = maskData[idx + 3]; if (a < 8) return false;
  const r = maskData[idx], g = maskData[idx + 1], b = maskData[idx + 2];
  const br = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return br < SIL_BRIGHTNESS_THRESHOLD;
}

/* =======================================================
   Draw loop
======================================================= */
function draw() {
  background(BG_COLOR);

  // Character shuffle timing (~0.2s cadence)
  const nowMs = millis();
  if (nowMs - lastCharRefreshAt >= CHAR_REFRESH_MS) {
    charTick++;
    lastCharRefreshAt = nowMs;
  }

  // 1) refresh video mask & cache pixels (throttled)
  updateSilhouetteMask();

  // 2) FADE the ASCII layer toward the background (temporal blur)
  const fadeAlpha = 255 * (1 - Math.exp(- (deltaTime || 16.7) / ASCII_FADE_TAU_MS));
  asciiLayer.push();
  asciiLayer.colorMode(RGB, 255);
  asciiLayer.noStroke();
  asciiLayer.fill(BG_RGB.r, BG_RGB.g, BG_RGB.b, fadeAlpha); // fade toward BG
  asciiLayer.rect(0, 0, width, height);
  asciiLayer.pop();

  // 3) Draw ASCII for current frame ONTO asciiLayer
  asciiLayer.push();
  asciiLayer.colorMode(HSL, 360, 100, 100, 255);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cx = gx * GRID + GRID / 2;
      const cy = gy * GRID + GRID / 2;
      if (!isSilhouetteAt(cx, cy)) continue;

      const { h, s, l } = cellHSL[gy][gx];
      const ch = charForFrame(gx, gy, charTick);
      asciiLayer.fill(h, s, l, 235);
      asciiLayer.textSize(GRID * 1.15);
      asciiLayer.text(ch, cx, cy);
    }
  }
  asciiLayer.pop();

  // 4) Blit the ASCII layer onto the main canvas
  image(asciiLayer, 0, 0);

  // 5) (images) update + draw drips
  colorMode(RGB, 255);
  for (let i = drips.length - 1; i >= 0; i--) {
    const d = drips[i];
    d.update();
    d.draw();
    if (d.isDone()) drips.splice(i, 1);
  }
}

/* =======================================================
   Utility & placeholders
======================================================= */
// (no in-canvas UI or reserved zones anymore)

function hashCell(x, y) {
  const s = sin((x + 13.37) * (y + 7.77));
  return abs(s * 43758.5453) % 1;
}

/* =======================================================
   END OF FILE
======================================================= */
