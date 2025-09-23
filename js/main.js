/* =========================================================
   BENTO: PRELOADER + SNAKE PACKER + SQUARIFY-AND-GROW HOVER
   + Yarndings gap-fill overlays that fade out when tiles grow
   ========================================================= */

/* ----------------------------
   1) PRELOADER
---------------------------- */
const SEQ = {
  path: i => `preloader/frames/frame_${String(i).padStart(4,'0')}.png`,
  first: 1,
  last: 60,
  fps: 24
};

const preloader = document.getElementById('preloader');
const preCanvas = document.getElementById('preCanvas');
const ctx       = preCanvas?.getContext('2d');
const pctEl     = document.getElementById('pct');

let seqImages = [];
let loadedFrames = 0;
let playLoopReq = null;

function sizePreCanvas() {
  if (!preCanvas) return;
  const cw = preCanvas.clientWidth || 320;
  const ch = preCanvas.clientHeight || 320;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  preCanvas.width  = Math.round(cw * dpr);
  preCanvas.height = Math.round(ch * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function loadSequence() {
  const promises = [];
  for (let i = SEQ.first; i <= SEQ.last; i++) {
    const img = new Image();
    img.decoding = 'async';
    img.src = SEQ.path(i);
    seqImages.push(img);
    promises.push(new Promise(res => {
      img.onload = () => { loadedFrames++; pctEl && (pctEl.textContent = Math.round((loadedFrames/SEQ.last)*100)+'%'); res(true); };
      img.onerror = () => { console.warn('[preloader] missing frame:', img.src); res(false); };
    }));
  }
  return Promise.all(promises);
}
function fitCover(w,h,W,H){ const r=Math.max(W/w,H/h); const nw=w*r, nh=h*r; return {x:(W-nw)/2,y:(H-nh)/2,w:nw,h:nh}; }
function drawFallback(t){
  if (!preCanvas) return;
  const W = preCanvas.clientWidth||320, H = preCanvas.clientHeight||320;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#0e111a'; ctx.fillRect(0,0,W,H);
  const r = 8 + 6*(0.5+0.5*Math.sin(t/500));
  ctx.beginPath(); ctx.arc(W/2,H/2,r,0,Math.PI*2); ctx.fillStyle='#69f'; ctx.fill();
}
function playSequenceLoop(){
  sizePreCanvas();
  let frame = 0, W = preCanvas.clientWidth||320, H = preCanvas.clientHeight||320, SP=1000/SEQ.fps, last=performance.now();
  function loop(t){
    const dt=t-last;
    if(dt>=SP){
      last=t; ctx.clearRect(0,0,W,H);
      if(loadedFrames>0){
        const img=seqImages[frame%seqImages.length];
        const box=fitCover(img.naturalWidth||1024,img.naturalHeight||1024,W,H);
        ctx.drawImage(img,box.x,box.y,box.w,box.h); frame++;
      } else { drawFallback(t); }
    }
    playLoopReq=requestAnimationFrame(loop);
  }
  playLoopReq=requestAnimationFrame(loop);
}

/* ----------------------------
   2) GRID & SHAPES
---------------------------- */
const grid = document.getElementById('bentoGrid');

function readGridVars(){
  const cs = getComputedStyle(document.documentElement);
  return {
    cols: parseInt(cs.getPropertyValue('--cols')) || 20,
    rows: parseInt(cs.getPropertyValue('--rows')) || 12
  };
}

/* snake-forward weights for initial build */
const SHAPES_WEIGHTED = [
  [5,1,  8], [1,5,  8],
  [4,1, 10], [1,4, 10],
  [3,1, 12], [1,3, 12],
  [2,1, 10], [1,2, 10],
  [2,2,  6],
  [1,1, 16],
];

function shapeBag(weighted){
  const bag=[];
  for (const [w,h,wt] of weighted){ for (let i=0;i<wt;i++) bag.push([w,h]); }
  return bag;
}
const BASE_BAG = shapeBag(SHAPES_WEIGHTED);

function mulberry32(seed){
  return function(){
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rngInt = (rng,min,max)=> Math.floor(rng()*(max-min+1))+min;

/* ----------------------------
   3) INITIAL BUILD (snake-biased)
---------------------------- */
function fits(occ, c, r, w, h, cols, rows) {
  if (c + w > cols || r + h > rows) return false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (occ[r + y][c + x]) return false;
  return true;
}
function mark(occ, c, r, w, h, val=true) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) occ[r + y][c + x] = val;
}

function makeTile(col, row, w, h){
  const el = document.createElement('div');
  el.className = 'tile';
  el.style.gridColumn = `${col} / ${col + w}`;
  el.style.gridRow    = `${row} / ${row + h}`;
  el.dataset.col = String(col);
  el.dataset.row = String(row);
  el.dataset.w   = String(w);
  el.dataset.h   = String(h);

  const img = document.createElement('img');
  img.src = 'gifs/eye.gif';
  img.loading = 'lazy';
  img.decoding = 'async';
  el.appendChild(img);
  return el;
}

function buildBentoInto(gridEl, seed=Date.now()){
  const { cols, rows } = readGridVars();
  gridEl.innerHTML = '';

  const occ = Array.from({ length: rows }, () => Array(cols).fill(false));
  const rng = mulberry32(seed);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (occ[r][c]) continue;
      const candidates = [];
      for (let k=0;k<10;k++) candidates.push(BASE_BAG[rngInt(rng,0,BASE_BAG.length-1)]);
      if (rng() < 0.55) candidates.sort((a,b)=>(b[0]-b[1])-(a[0]-a[1])); else candidates.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]));
      let placed=false;
      for (const [w,h] of candidates){
        if (fits(occ,c,r,w,h,cols,rows)){
          mark(occ,c,r,w,h,true);
          gridEl.appendChild(makeTile(c+1,r+1,w,h));
          placed=true; break;
        }
      }
      if (!placed){ mark(occ,c,r,1,1,true); gridEl.appendChild(makeTile(c+1,r+1,1,1)); }
    }
  }
}

/* ----------------------------
   4) LOCAL SQUARIFY + CHAIN GROWTH + YARNDINGS OVERLAY
---------------------------- */
let tiles = [];
function refreshTiles(){ tiles = Array.from(grid.children); }

function gridMetrics(){
  const { cols, rows } = readGridVars();
  const rect = grid.getBoundingClientRect();
  return { cols, rows, rect, cellW: rect.width / cols, cellH: rect.height / rows };
}

/* Occupancy that stores tile refs (or null) */
function buildOccMap(){
  const { cols, rows } = readGridVars();
  const occ = Array.from({ length: rows }, () => Array(cols).fill(null));
  for (const t of tiles){
    const c = +t.dataset.col - 1, r = +t.dataset.row - 1, w = +t.dataset.w, h = +t.dataset.h;
    for (let y=0;y<h;y++) for (let x=0;x<w;x++){
      occ[r+y][c+x] = t;
    }
  }
  return occ;
}

function cellsInRadius(cx, cy, radCells, cols, rows){
  const cells=[]; const r2 = radCells*radCells;
  const x0 = Math.max(0, Math.floor(cx - radCells));
  const y0 = Math.max(0, Math.floor(cy - radCells));
  const x1 = Math.min(cols-1, Math.ceil (cx + radCells));
  const y1 = Math.min(rows-1, Math.ceil (cy + radCells));
  for (let gy=y0; gy<=y1; gy++){
    for (let gx=x0; gx<=x1; gx++){
      const dx = gx + 0.5 - cx;
      const dy = gy + 0.5 - cy;
      if (dx*dx + dy*dy <= r2) cells.push([gx,gy]);
    }
  }
  return cells;
}

/* Does any cell of tile fall inside regionSet? */
function intersectsRegion(tile, regionSet){
  const c = +tile.dataset.col - 1, r = +tile.dataset.row - 1, w = +tile.dataset.w, h = +tile.dataset.h;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    if (regionSet.has(`${c+x},${r+y}`)) return true;
  }
  return false;
}

/* Shrink tile to 1×1: keep the cell of this tile closest to cursor center */
function squarifyTileToward(tile, gx, gy, occ){
  let c = +tile.dataset.col - 1, r = +tile.dataset.row - 1, w = +tile.dataset.w, h = +tile.dataset.h;

  // find the tile-cell closest to (gx,gy)
  let keepX = c, keepY = r, best = Infinity;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const cx = c + x + 0.5, cy = r + y + 0.5;
    const d2 = (cx-gx)*(cx-gx) + (cy-gy)*(cy-gy);
    if (d2 < best){ best = d2; keepX = c + x; keepY = r + y; }
  }

  // free all current cells
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    occ[r+y][c+x] = null;
  }

  // occupy only the kept cell
  occ[keepY][keepX] = tile;

  // write DOM datasets/styles
  tile.dataset.col = String(keepX + 1);
  tile.dataset.row = String(keepY + 1);
  tile.dataset.w   = "1";
  tile.dataset.h   = "1";
  tile.style.gridColumn = `${keepX + 1} / ${keepX + 2}`;
  tile.style.gridRow    = `${keepY + 1} / ${keepY + 2}`;
  tile.classList.add('morph');
}

/* Attempt to extend a tile rectangle by 1 cell into target (tx,ty) */
function extendTileInto(tile, tx, ty, occ){
  const cols = occ[0].length, rows = occ.length;
  if (tx<0||ty<0||tx>=cols||ty>=rows) return false;
  if (occ[ty][tx] !== null) return false; // not empty

  let c = +tile.dataset.col - 1, r = +tile.dataset.row - 1, w = +tile.dataset.w, h = +tile.dataset.h;

  // Left
  if (tx === c-1 && ty >= r && ty < r+h){
    c -= 1; w += 1;
    occ[ty][tx] = tile;
    tile.dataset.col = String(c + 1);
    tile.dataset.w   = String(w);
    tile.style.gridColumn = `${c + 1} / ${c + 1 + w}`;
    tile.classList.add('morph');
    removeYarndingAt(tx, ty);
    return true;
  }
  // Right
  if (tx === c+w && ty >= r && ty < r+h){
    w += 1;
    occ[ty][tx] = tile;
    tile.dataset.w = String(w);
    tile.style.gridColumn = `${c + 1} / ${c + 1 + w}`;
    tile.classList.add('morph');
    removeYarndingAt(tx, ty);
    return true;
  }
  // Top
  if (ty === r-1 && tx >= c && tx < c+w){
    r -= 1; h += 1;
    occ[ty][tx] = tile;
    tile.dataset.row = String(r + 1);
    tile.dataset.h   = String(h);
    tile.style.gridRow = `${r + 1} / ${r + 1 + h}`;
    tile.classList.add('morph');
    removeYarndingAt(tx, ty);
    return true;
  }
  // Bottom
  if (ty === r+h && tx >= c && tx < c+w){
    h += 1;
    occ[ty][tx] = tile;
    tile.dataset.h = String(h);
    tile.style.gridRow = `${r + 1} / ${r + 1 + h}`;
    tile.classList.add('morph');
    removeYarndingAt(tx, ty);
    return true;
  }

  return false;
}

/* Neighbor-order helper (currently unused but handy) */
function neighborOrderFor(tile){
  const w = +tile.dataset.w, h = +tile.dataset.h;
  if (w > h) return [[1,0],[-1,0],[0,1],[0,-1]];
  if (h > w) return [[0,1],[0,-1],[1,0],[-1,0]];
  return [[1,0],[-1,0],[0,1],[0,-1]];
}

/* Growth iteration: for each empty cell, let ONE neighbor tile claim it */
function growthPass(regionSet, occ){
  const cols = occ[0].length, rows = occ.length;

  const empties = [];
  regionSet.forEach(key=>{
    const [sx,sy] = key.split(',').map(n=>+n);
    if (occ[sy] && occ[sy][sx] === null) empties.push([sx,sy]);
  });

  let grew = 0;
  for (const [ex,ey] of empties){
    const neighbors = [];
    if (ex>0         && occ[ey][ex-1]) neighbors.push(occ[ey][ex-1]);
    if (ex<cols-1    && occ[ey][ex+1]) neighbors.push(occ[ey][ex+1]);
    if (ey>0         && occ[ey-1][ex]) neighbors.push(occ[ey-1][ex]);
    if (ey<rows-1    && occ[ey+1][ex]) neighbors.push(occ[ey+1][ex]);

    const seen = new Set();
    for (const nb of neighbors){
      if (!nb || seen.has(nb)) continue;
      seen.add(nb);
      if (extendTileInto(nb, ex, ey, occ)){
        grew++;
        break;
      }
    }
  }
  return grew;
}

let finalFillTimer = null;
function scheduleFinalFill(regionSetSnapshot) {
  if (finalFillTimer) {
    clearTimeout(finalFillTimer);
    finalFillTimer = null;
  }
  finalFillTimer = setTimeout(() => {
    refreshTiles();
    let occ = buildOccMap();

    const focusSet = new Set();
    regionSetSnapshot.forEach(key => {
      if (yarndingsMap.has(key)) focusSet.add(key);
    });

    const MAX_FINAL_ITERS = 20;
    for (let i=0; i<MAX_FINAL_ITERS; i++) {
      const grew = growthPass(focusSet, occ);
      focusSet.forEach(k => {
        const [x,y] = k.split(',').map(Number);
        if (occ[y] && occ[y][x] !== null) removeYarndingAt(x,y);
      });
      if (!grew) break;
    }

    finalFillTimer = null;
  }, 1000);
}

/* ----------------------------
   Yarndings overlay manager
---------------------------- */
const YARN_TEXT = "Whereas disregard and contempt for human rights have resulted";
const YARN_CHARS = YARN_TEXT.replace(/\s+/g, '').split('');
let ydIndex = 0;
function nextYarnChar() {
  const ch = YARN_CHARS[ydIndex % YARN_CHARS.length];
  ydIndex++;
  return ch;
}
function randomNiceColor() {
  const hue = Math.floor(Math.random()*360);
  const sat = 60 + Math.floor(Math.random()*30);
  const light = 40 + Math.floor(Math.random()*20);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

const yarndingsMap = new Map(); // key "x,y" -> element
function cellKey(x,y){ return `${x},${y}`; }

function spawnYarndingAt(x, y) {
  const key = cellKey(x,y);
  if (yarndingsMap.has(key)) return yarndingsMap.get(key);

  const { cellW, cellH } = gridMetrics();

  const el = document.createElement('div');
  el.className = 'yarnding';
  el.textContent = nextYarnChar();
  el.style.color = randomNiceColor();

  el.style.left = `${x * cellW}px`;
  el.style.top  = `${y * cellH}px`;
  el.style.width  = `${cellW}px`;
  el.style.height = `${cellH}px`;
  el.style.fontSize = `${Math.floor(Math.min(cellW, cellH) * 0.66)}px`;
  el.style.zIndex = '9999';
  el.style.opacity = '0.95';
  el.style.transform = 'translateZ(0)';

  grid.appendChild(el);
  yarndingsMap.set(key, el);

  return el;
}

function removeYarndingAt(x, y) {
  const key = cellKey(x,y);
  const el = yarndingsMap.get(key);
  if (!el) return;
  el.classList.add('yarnding--vanish');
  el.addEventListener('animationend', () => {
    el.remove();
    yarndingsMap.delete(key);
  }, { once: true });
}

/* ----------------------------
   Hover: squarify + growth + spawn glyphs in any still-empty cells
---------------------------- */
let lastHover = 0;
const HOVER_THROTTLE_MS = 20;

function handleHover(clientX, clientY){
  const { cols, rows, rect, cellW, cellH } = gridMetrics();

  const gx = (clientX - rect.left) / cellW;
  const gy = (clientY - rect.top)  / cellH;

  const RADIUS_PX = 100;
  const radCells = Math.max(RADIUS_PX / cellW, RADIUS_PX / cellH);

  const regionCells = cellsInRadius(gx, gy, radCells, cols, rows);
  if (!regionCells.length) return;
  const regionSet = new Set(regionCells.map(([x,y])=>`${x},${y}`));

  refreshTiles();
  let occ = buildOccMap();

  // 1) squarify
  const victims = tiles.filter(t => intersectsRegion(t, regionSet));
  for (const t of victims){
    squarifyTileToward(t, gx, gy, occ);
  }

  // 2) quick chain growth
  const MAX_ITERS = 5;
  for (let it=0; it<MAX_ITERS; it++){
    const grew = growthPass(regionSet, occ);
    if (!grew) break;
  }

  // 3) letters in any still-empty cells
  regionSet.forEach(key=>{
    const [x,y] = key.split(',').map(Number);
    if (occ[y] && occ[y][x] === null) {
      spawnYarndingAt(x, y);
    } else {
      removeYarndingAt(x, y);
    }
  });

  // 4) schedule final fill after ~1s
  scheduleFinalFill(regionSet);
} // <<< FIX: close handleHover function

/* throttle hover */
grid.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - lastHover < HOVER_THROTTLE_MS) return;
  lastHover = now;
  handleHover(e.clientX, e.clientY);
});

/* ----------------------------
   5) CLICK = FULL REBUILD (and clear stray glyphs)
---------------------------- */
grid.addEventListener('click', () => {
  buildBentoInto(grid, Date.now());
  refreshTiles();
  yarndingsMap.forEach(el => el.remove());
  yarndingsMap.clear();
});

/* ----------------------------
   6) BOOT
---------------------------- */
(async function boot(){
  try {
    const seqPromise = loadSequence();
    playSequenceLoop();

    const gifWarmup = new Promise(res=>{
      const g = new Image(); g.src = 'gifs/eye.gif'; g.onload = res; g.onerror = res;
    });

    await Promise.race([
      Promise.all([seqPromise, gifWarmup]),
      new Promise(res => setTimeout(res, 1200))
    ]);

    buildBentoInto(grid, Date.now());
    document.getElementById('bentoWorld')?.classList.add('ready');
    refreshTiles();

    preloader?.classList.add('hide');
    if (playLoopReq) cancelAnimationFrame(playLoopReq);
    setTimeout(()=> preloader?.remove(), 350);
  } catch (e) {
    console.error('Boot error:', e);
    buildBentoInto(grid, Date.now());
    document.getElementById('bentoWorld')?.classList.add('ready');
    refreshTiles();
    preloader?.classList.add('hide');
    if (playLoopReq) cancelAnimationFrame(playLoopReq);
    setTimeout(()=> preloader?.remove(), 350);
  }
})();
