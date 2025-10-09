/* aboutpicture.js — BG tiling growth (center-out, sequential) + Responsive Playground FAB (z=912)
   - Loads about_1..about_15.* from ./aboutimgs
   - Tiles are auto-sized to reduce gaps; centered grid; square tiles (good for your square imgs)
   - BG look: modulesPerFrame=120, maxModules=4000, rings=3
   - HD exports: Download 1000×1000 and Download 2048×2048 (crisp, native renders)
   - No p5 name collisions (IIFE, scoped helpers)
*/
(function(){
  'use strict';

  const CFG = {
    bootOnPaths: ['about'],

    // BG canvas / tiling
    canvasOpacity: 0.22,
    gap: 8,         // tighter gaps
    pad: 4,         // small edge padding
    maxTileW: 420,
    maxTileH: 420,

    // images to try per index
    folder: './aboutimgs',
    seqPrefix: 'about_',
    seqStart: 1,
    seqEnd: 15,
    seqExts: ['.png','.jpg','.jpeg','.webp'],

    // growth look
    modulesPerFrame: 120,
    maxModules: 4000,
    rings: 3,

    // module style
    startCells: 4,
    minCell: 8,
    minRadius: 2.5,
    maxRadius: 80,
    ringThickness: 0.16,
    ringSpacing: 0.22,
    strokeAlpha: 0.9,
    fillAlpha: 0.9,
    bgColor: '#0e111a',
    sobelBoost: 1.0,

    // FAB
    fabZ: 912,
    wantTiles: 15,   // target tile count
    minTile: 160     // don't go smaller than this
  };

  if (window.__ABOUTPICTURE_FINAL15_TIGHT_HD__) return;
  window.__ABOUTPICTURE_FINAL15_TIGHT_HD__ = true;

  const ok = CFG.bootOnPaths.some(s => location.pathname.toLowerCase().includes(s));
  if (!ok) return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  } else {
    boot();
  }

  async function boot(){
    // 1) Playground FAB (shows immediately)
    buildFAB();

    // 2) Fullscreen background canvas
    const bg = document.createElement('canvas');
    Object.assign(bg.style, {
      position:'fixed', inset:'0',
      width:'100vw', height:'100vh',
      zIndex: 0,
      pointerEvents:'none',
      opacity: String(CFG.canvasOpacity)
    });
    document.body.insertBefore(bg, document.body.firstChild);
    const bgCtx = bg.getContext('2d', { willReadFrequently: true });

    const sizeBG = () => { bg.width = innerWidth; bg.height = innerHeight; };
    sizeBG();

    // compute rects for tiling (centered, tight)
    let layout = computeCenterOutRects(bg.width, bg.height);

    addEventListener('resize', () => {
      sizeBG();
      layout = computeCenterOutRects(bg.width, bg.height);
      // NOTE: we do not repaint old tiles on resize; keep whatever is on screen.
    });

    // 3) Run background tiling sequence (non-blocking)
    (async function runBG(){
      let tileIdx = 0;
      for (let i = CFG.seqStart; i <= CFG.seqEnd && tileIdx < layout.rects.length; i++){
        const img = await tryLoadIndex(i);
        if (!img) { console.warn('[aboutpicture] missing image index', i); continue; }

        const r = layout.rects[tileIdx++]; // r has x,y,w,h (square)
        const fit = fitContain(img.naturalWidth, img.naturalHeight, r.w, r.h);

        // offscreen painter (the “growth” canvas)
        const off = document.createElement('canvas');
        off.width = fit.w; off.height = fit.h;
        const octx = off.getContext('2d', { willReadFrequently: true });

        drawFitted(octx, img, fit.w, fit.h, CFG.bgColor);
        const targetImg = octx.getImageData(0,0,fit.w,fit.h);
        const gradMag = sobelMagnitude(targetImg, fit.w, fit.h, CFG.sobelBoost);

        // center inside allocated rect
        const px = r.x + ((r.w - fit.w) >> 1);
        const py = r.y + ((r.h - fit.h) >> 1);

        await paintInto(off, targetImg, gradMag, {
          modulesPerFrame: CFG.modulesPerFrame,
          maxModules: CFG.maxModules,
          startCells: CFG.startCells,
          minCell: CFG.minCell,
          rings: CFG.rings,
          ringThickness: CFG.ringThickness,
          ringSpacing: CFG.ringSpacing,
          strokeAlpha: CFG.strokeAlpha,
          fillAlpha: CFG.fillAlpha,
          minRadius: CFG.minRadius,
          maxRadius: CFG.maxRadius,
          bg: CFG.bgColor,
          onFrame: () => {
            bgCtx.clearRect(px, py, fit.w, fit.h);
            bgCtx.drawImage(off, px, py);
          }
        });

        // final blit
        bgCtx.drawImage(off, px, py);
      }
    })();
  }

  async function tryLoadIndex(i){
    const base = CFG.folder.replace(/\/$/,'') + '/' + CFG.seqPrefix + i;
    for (const ext of CFG.seqExts){
      try { return await loadImage(base + ext); } catch {}
    }
    return null;
  }

  // ---------- Tiling layout (tight, centered, square tiles) ----------
  function computeCenterOutRects(W, H){
    const { gap, pad, maxTileW, maxTileH, minTile, wantTiles } = CFG;

    // search for the best number of columns that yields the largest tile side
    let best = null; // {cols, rows, side, startX, startY}
    const maxCols = Math.max(1, Math.floor((W - pad*2 + gap) / (minTile + gap)));
    for (let cols = 1; cols <= maxCols; cols++){
      // rows needed to place ~wantTiles
      const rowsNeeded = Math.ceil(wantTiles / cols);
      // clamp rows to what fits vertically at minimum tile size
      const maxRowsFit = Math.max(1, Math.floor((H - pad*2 + gap) / (minTile + gap)));
      const rows = Math.min(rowsNeeded, maxRowsFit);

      // compute side length that fits both width and height with given cols/rows
      const sideW = Math.floor((W - pad*2 - (cols-1)*gap) / cols);
      const sideH = Math.floor((H - pad*2 - (rows-1)*gap) / rows);
      let side = Math.min(sideW, sideH, maxTileW, maxTileH);
      side = Math.max(side, minTile);
      // must still fit
      if ((cols * (side + gap) - gap) > (W - pad*2) + 0.5) continue;
      if ((rows * (side + gap) - gap) > (H - pad*2) + 0.5) continue;

      const gridW = cols * side + (cols-1) * gap;
      const gridH = rows * side + (rows-1) * gap;
      const startX = Math.round((W - gridW) / 2);
      const startY = Math.round((H - gridH) / 2);

      if (!best || side > best.side) {
        best = { cols, rows, side, startX, startY };
      }
    }

    // fallback if best is null (tiny screens)
    if (!best) {
      const side = Math.max(minTile, Math.min(maxTileW, maxTileH));
      const cols = 1, rows = Math.max(1, Math.ceil(wantTiles / cols));
      const gridW = side, gridH = rows*side + (rows-1)*gap;
      const startX = Math.round((W - gridW)/2);
      const startY = Math.round((H - gridH)/2);
      best = { cols, rows, side, startX, startY };
    }

    const rects = [];
    for (let j=0; j<best.rows; j++){
      for (let i=0; i<best.cols; i++){
        const x = best.startX + i*(best.side + gap);
        const y = best.startY + j*(best.side + gap);
        rects.push({ x, y, w: best.side, h: best.side });
      }
    }

    // order center-out (distance to screen center)
    const Cx = W/2, Cy = H/2;
    rects.sort((a,b)=>{
      const ax = a.x + a.w/2, ay = a.y + a.h/2;
      const bx = b.x + b.w/2, by = b.y + b.h/2;
      const da = (ax-Cx)*(ax-Cx) + (ay-Cy)*(ay-Cy);
      const db = (bx-Cx)*(bx-Cx) + (by-Cy)*(by-Cy);
      if (da !== db) return da - db;
      return Math.atan2(ay-Cy, ax-Cx) - Math.atan2(by-Cy, bx-Cx);
    });

    return { rects, side: best.side };
  }

  // ---------- Offscreen painter ----------
  function paintInto(canvas, targetImg, gradMag, opt){
    return new Promise((resolve)=>{
      const W = canvas.width, H = canvas.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = opt.bg; ctx.fillRect(0,0,W,H);

      // tiny max-heap
      const heap=[]; const push=c=>{ heap.push(c); for(let i=heap.length-1;i>0;){ const p=(i-1)>>1; if(heap[p].score>=heap[i].score) break; [heap[p],heap[i]]=[heap[i],heap[p]]; i=p; } };
      const pop =()=>{ const a=heap[0], b=heap.pop(); if(heap.length){ heap[0]=b; for(let i=0;;){ let l=i*2+1,r=l+1,m=i; if(l<heap.length&&heap[l].score>heap[m].score)m=l; if(r<heap.length&&heap[r].score>heap[m].score)m=r; if(m===i)break; [heap[m],heap[i]]=[heap[i],heap[m]]; i=m; } } return a; };

      // seed
      const N = opt.startCells, cw=W/N, ch=H/N;
      for (let j=0;j<N;j++) for (let i=0;i<N;i++){
        const c = { x:i*cw, y:j*ch, w:cw, h:ch, score:0 };
        c.score = cellScore(c, gradMag, W, H); push(c);
      }

      let modules=0, raf=0;
      (function loop(){
        let budget = Math.min(opt.modulesPerFrame, opt.maxModules - modules);
        while (budget>0 && heap.length>0){
          const cell = pop();
          drawModule(ctx, cell, targetImg, gradMag, opt, W, H);
          modules++; budget--;
          if (Math.min(cell.w, cell.h) > opt.minCell){
            const hw=cell.w/2, hh=cell.h/2;
            for (const [dx,dy] of [[0,0],[hw,0],[0,hh],[hw,hh]]) {
              const c = { x:cell.x+dx, y:cell.y+dy, w:hw, h:hh, score:0 };
              c.score = cellScore(c, gradMag, W, H); push(c);
            }
          }
        }
        opt.onFrame && opt.onFrame();
        if (modules >= opt.maxModules || heap.length === 0){
          if (raf) cancelAnimationFrame(raf);
          resolve();
          return;
        }
        raf = requestAnimationFrame(loop);
      })();
    });
  }

  function drawModule(ctx, cell, targetImg, gradMag, opt, W, H){
    const cx = cell.x + cell.w*0.5;
    const cy = cell.y + cell.h*0.5;
    const r  = Math.max(CFG.minRadius, Math.min(CFG.maxRadius, 0.5*Math.max(cell.w, cell.h)));

    const cCenter = sampleRGBA(targetImg, cx|0, cy|0, W);
    const gdir = approxGradientDir(gradMag, cx|0, cy|0, W, H);
    const ex = clamp(cx + gdir.x * r*0.6, 0, W-1)|0;
    const ey = clamp(cy + gdir.y * r*0.6, 0, H-1)|0;
    const cEdge = sampleRGBA(targetImg, ex, ey, W);

    // inner fill
    ctx.save();
    ctx.globalAlpha = opt.fillAlpha;
    ctx.fillStyle = rgbaStr(cCenter);
    ctx.beginPath(); ctx.arc(cx, cy, r*(1 - opt.ringSpacing*opt.rings), 0, Math.PI*2); ctx.fill();
    ctx.restore();

    // rings
    if (opt.rings > 0){
      ctx.save();
      ctx.globalAlpha = opt.strokeAlpha;
      for (let i=0;i<opt.rings;i++){
        const t = (i+1)/opt.rings;
        const rr = Math.max(1, r*(1 - t*opt.ringSpacing*0.9));
        const lw = Math.max(0.5, r * opt.ringThickness * (0.9 - 0.2*t));
        const mix = lerpColor(cEdge, cCenter, 0.35 + 0.4*(1-t));
        ctx.strokeStyle = rgbaStr(mix);
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI*2); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function cellScore(cell, grad, W, H){
    const x0 = Math.max(0, cell.x|0), y0 = Math.max(0, cell.y|0);
    const x1 = Math.min(W-1, (cell.x+cell.w)|0), y1 = Math.min(H-1, (cell.y+cell.h)|0);
    let sum=0, cnt=0, stride = Math.max(1, Math.floor(Math.min(cell.w, cell.h)/10));
    for (let y=y0; y<=y1; y+=stride){
      const base=y*W;
      for (let x=x0; x<=x1; x+=stride){ sum += grad[base + x]; cnt++; }
    }
    return cnt ? (sum/cnt) : 0;
  }

// ---------- Playground FAB (compact, no-scroll, fits one screen) ----------
function buildFAB(){
  const host = document.createElement('div');
  Object.assign(host.style, {
    position:'fixed', right:'20px', bottom:'20px',
    zIndex:String(CFG.fabZ), pointerEvents:'auto'
  });
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode:'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing:border-box; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }

    .fab {
      position:fixed; right:20px; bottom:20px; width:46px; height:46px; border-radius:999px;
      background:#12151f; color:#e6e8f0; border:1px solid rgba(255,255,255,.15);
      display:grid; place-items:center; cursor:pointer; box-shadow:0 10px 28px rgba(0,0,0,.35);
    }
    .fab:hover { background:#171b27; }

    .panel {
      position:fixed; right:56px; bottom:20px;
      width:clamp(320px, 92vw, 520px);
      background:#0e111a; color:#e6e8f0; border:1px solid rgba(255,255,255,.15);
      border-radius:16px; box-shadow:0 18px 40px rgba(0,0,0,.45);
      padding:12px; display:none;
      /* Fit on one screen */
      max-height:calc(100vh - 40px);
      overflow:hidden;
    }
    .panel.open { display:block; }

    .hdr { display:flex; align-items:center; gap:8px; margin:2px 2px 6px; }
    .title { font-weight:600; font-size:13px; letter-spacing:.2px; }
    .sub { font-size:11px; color:#9aa0a6; margin:0 0 8px 2px; }

    /* Compact content grid: header, main canvas, controls, buttons, stats, (optional preview) */
    .content { display:grid; grid-template-rows:auto auto auto auto auto auto; gap:8px; }

    /* Canvases scale to fit */
    canvas { width:100%; height:auto; display:block; border-radius:12px; box-shadow:0 8px 22px rgba(0,0,0,.3) }
    .mainCanvas { max-height:34vh; }     /* keep panel short */
    .preview { border:1px dashed rgba(255,255,255,.15); max-height:18vh; }

    .row { display:grid; grid-template-columns:1fr; gap:6px; }
    label { font-size:11px; opacity:.9 }

    .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
    .gcell { display:grid; gap:4px; }
    .gcell > div { font-size:11px; opacity:.8 }

    input[type="range"] { width:100% }

    .btnrow {
      display:flex; flex-wrap:wrap; gap:8px;
    }
    button {
      padding:8px 10px; border-radius:10px; border:1px solid rgba(255,255,255,.15);
      background:#12151f; color:#e6e8f0; cursor:pointer;
      font-size:12px; line-height:1;
    }
    button:hover { background:#171b27; }

    .stats { font-size:11px; color:#9aa0a6; margin-top:0; }

    /* Small screens = bottom sheet, still one-screen fit */
    @media (max-width: 680px) {
      .panel {
        right:0; left:0; bottom:0; top:auto;
        border-radius:14px 14px 0 0;
        padding:10px 10px calc(10px + env(safe-area-inset-bottom));
        max-height:calc(100vh - 24px);
      }
      .grid3 { grid-template-columns:1fr; }
      .mainCanvas { max-height:38vh; }
    }

    /* Very short viewports: hide preview to avoid scrolling */
    @media (max-height: 720px) {
      .preview { display:none !important; }
    }
  `;
  shadow.appendChild(style);

  const fab = document.createElement('div');
  fab.className='fab';
  fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="24" height="24" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>
  </svg>`;
  shadow.appendChild(fab);

  const panel = document.createElement('div'); panel.className='panel'; shadow.appendChild(panel);
  fab.addEventListener('click', ()=> panel.classList.toggle('open'));

  const hdr = div('hdr'); hdr.appendChild(div('title','Try your own image'));
  const sub = div('sub','Upload and render with the same concentric-circle growth.');

  const content = div('content');

  // Main canvas (internal res stays 540; CSS scales it)
  const W=540, H=540;
  const canvas = document.createElement('canvas'); canvas.width=W; canvas.height=H; canvas.className='mainCanvas';
  const preview = document.createElement('canvas'); preview.width=W; preview.height=H; preview.className='preview';

  const row = document.createElement('div'); row.className='row';
  const label = document.createElement('label'); label.textContent='Upload portrait image';
  const input = Object.assign(document.createElement('input'), { type:'file', accept:'image/png,image/jpeg,image/webp' });
  row.append(label, input);

  // Compact sliders
  const sliders = div('grid3');
  const sRate  = sliderCell('Modules / frame', 10, 400, 10, CFG.modulesPerFrame);
  const sMax   = sliderCell('Max modules', 2000, 30000, 1000, CFG.maxModules);
  const sRings = sliderCell('Rings', 0, 3, 1, CFG.rings);
  sliders.append(sRate.wrap, sMax.wrap, sRings.wrap);

  // Buttons (wrap)
  const btns = div('btnrow');
  const bStart    = makeBtn('Start');
  const bPause    = makeBtn('Pause');
  const bReset    = makeBtn('Reset');
  const bSave     = makeBtn('Download');
  const bSave1000 = makeBtn('Download 1000×1000');
  const bSaveHD   = makeBtn('Download HD (2048)');
  btns.append(bStart,bPause,bReset,bSave,bSave1000,bSaveHD);

  const stats = div('stats','modules: — | cells: — | gen: —');

  content.append(canvas, row, sliders, btns, stats, preview);
  panel.append(hdr, sub, content);

  // contexts
  const ctx  = canvas.getContext('2d', { willReadFrequently: true });
  const pv   = preview.getContext('2d', { willReadFrequently: true });
  const off  = document.createElement('canvas'); off.width=W; off.height=H;
  const octx = off.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = CFG.bgColor; ctx.fillRect(0,0,W,H);
  pv.fillStyle  = CFG.bgColor; pv.fillRect(0,0,W,H);

  let running=false, raf=0, gen=0, modules=0, heap=[];
  let targetImg=null, grad=null, uploadedImg=null;

  input.addEventListener('change', async (e)=>{
    const f=e.target.files?.[0]; if (!f) return;
    const img = await readFileAsImage(f);
    uploadedImg = img;
    drawFitted(pv, img, W, H, CFG.bgColor);
    drawFitted(octx, img, W, H, CFG.bgColor);
    targetImg = octx.getImageData(0,0,W,H);
    grad = sobelMagnitude(targetImg, W, H, CFG.sobelBoost);
    resetAndSeed();
  });

  bStart.addEventListener('click', ()=>{ if (!targetImg || running) return; running=true; raf=requestAnimationFrame(loopPanel); });
  bPause.addEventListener('click', ()=>{ running=false; if (raf) cancelAnimationFrame(raf); raf=0; });
  bReset.addEventListener('click', resetAndSeed);
  bSave.addEventListener('click', ()=>{ const a=document.createElement('a'); a.download='concentric-portrait.png'; a.href=canvas.toDataURL('image/png'); a.click(); });
  bSave1000.addEventListener('click', ()=> exportSized(1000));
  bSaveHD.addEventListener('click',   ()=> exportSized(2048));

  function resetAndSeed(){
    running=false; if (raf) cancelAnimationFrame(raf); raf=0;
    ctx.fillStyle = CFG.bgColor; ctx.fillRect(0,0,W,H);
    gen=0; modules=0; heap.length=0;

    const N = CFG.startCells, cw=W/N, ch=H/N;
    for (let j=0;j<N;j++) for (let i=0;i<N;i++){
      const c = { x:i*cw, y:j*ch, w:cw, h:ch, score:0 };
      c.score = cellScore(c, grad, W, H);
      heapPush(heap, c);
    }
    stats.textContent = `modules: ${modules} | cells: ${heap.length} | gen: ${gen}`;
  }

  function loopPanel(){
    if (!running) return;
    gen++;
    const P = {
      modulesPerFrame: +sRate.input.value,
      maxModules: +sMax.input.value,
      rings: +sRings.input.value,
      ringThickness: CFG.ringThickness,
      ringSpacing:  CFG.ringSpacing,
      strokeAlpha:  CFG.strokeAlpha,
      fillAlpha:    CFG.fillAlpha,
      minRadius:    CFG.minRadius,
      maxRadius:    CFG.maxRadius,
      startCells:   CFG.startCells,
      minCell:      CFG.minCell,
      bg:           CFG.bgColor,
    };

    let budget = Math.min(P.modulesPerFrame, P.maxModules - modules);
    while (budget>0 && heap.length>0){
      const cell = heapPop(heap);
      drawModule(ctx, cell, targetImg, grad, P, W, H);
      modules++; budget--;
      if (Math.min(cell.w, cell.h) > P.minCell){
        const hw=cell.w/2, hh=cell.h/2;
        for (const [dx,dy] of [[0,0],[hw,0],[0,hh],[hw,hh]]){
          const c = { x:cell.x+dx, y:cell.y+dy, w:hw, h:hh, score:0 };
          c.score = cellScore(c, grad, W, H);
          heapPush(heap, c);
        }
      }
    }
    stats.textContent = `modules: ${modules} | cells: ${heap.length} | gen: ${gen}`;
    if (modules >= P.maxModules || heap.length === 0){ running=false; return; }
    raf = requestAnimationFrame(loopPanel);
  }

  async function exportSized(TARGET){
    if (!uploadedImg) return;

    const hd = document.createElement('canvas'); hd.width = TARGET; hd.height = TARGET;
    const hctx = hd.getContext('2d', { willReadFrequently: true });
    drawFitted(hctx, uploadedImg, TARGET, TARGET, CFG.bgColor);
    const targetHD = hctx.getImageData(0,0,TARGET,TARGET);
    const gradHD = sobelMagnitude(targetHD, TARGET, TARGET, CFG.sobelBoost);

    const scaleArea = (TARGET*TARGET) / (W*H);
    const userMax = +sMax.input.value;
    const maxModules = Math.min(30000, Math.round(userMax * scaleArea * 0.9));
    const perFrame = 1000;

    await paintInto(hd, targetHD, gradHD, {
      modulesPerFrame: perFrame,
      maxModules,
      startCells: CFG.startCells,
      minCell: CFG.minCell,
      rings: +sRings.input.value,
      ringThickness: CFG.ringThickness,
      ringSpacing: CFG.ringSpacing,
      strokeAlpha: CFG.strokeAlpha,
      fillAlpha: CFG.fillAlpha,
      minRadius: CFG.minRadius,
      maxRadius: CFG.maxRadius,
      bg: CFG.bgColor
    });

    const a = document.createElement('a');
    a.download = `concentric-portrait-${TARGET}.png`;
    a.href = hd.toDataURL('image/png');
    a.click();
  }

  // local helpers inside shadow
  function makeBtn(txt){ const b=document.createElement('button'); b.textContent=txt; return b; }
  function div(cls, text){ const d=document.createElement('div'); if(cls) d.className=cls; if(text!=null) d.textContent=text; return d; }
  function sliderCell(label, min, max, step, value){
    const wrap = div('gcell');
    const l = document.createElement('label'); l.textContent = label;
    const r = document.createElement('input');
    Object.assign(r, { type:'range', min:String(min), max:String(max), step:String(step), value:String(value) });
    const v = document.createElement('div'); v.textContent = String(value);
    r.addEventListener('input', ()=> v.textContent = r.value);
    wrap.append(l, r, v);
    return { wrap, input:r, valueEl:v };
  }

  // small heap (panel)
  function heapPush(h,c){ h.push(c); for(let i=h.length-1;i>0;){ const p=(i-1)>>1; if(h[p].score>=h[i].score) break; [h[p],h[i]]=[h[i],h[p]]; i=p; } }
  function heapPop(h){ const a=h[0], b=h.pop(); if(h.length){ h[0]=b; for(let i=0;;){ let l=i*2+1,r=l+1,m=i; if(l<h.length&&h[l].score>h[m].score)m=l; if(r<h.length&&h[r].score>h[m].score)m=r; if(m===i)break; [h[m],h[i]]=[h[i],h[m]]; i=m; } } return a; }
}


  // ---------- shared utils ----------
  function readFileAsImage(file){ return new Promise((res, rej)=>{ const url=URL.createObjectURL(file); const img=new Image(); img.onload=()=>{ URL.revokeObjectURL(url); res(img); }; img.onerror=rej; img.src=url; }); }
  function loadImage(src){ return new Promise((res, rej)=>{ const img=new Image(); img.onload=()=>res(img); img.onerror=rej; img.src=src; }); }
  function fitContain(sw, sh, dw, dh){ const sr=sw/sh, dr=dw/dh; let w,h; if (sr>dr){ w=dw; h=dw/sr; } else { h=dh; w=dh*sr; } return { w:Math.round(w), h:Math.round(h) }; }
  function drawFitted(ctx2d, img, W, H, bg){ ctx2d.save(); ctx2d.fillStyle=bg; ctx2d.fillRect(0,0,W,H); const {w,h}=fitContain(img.naturalWidth,img.naturalHeight,W,H); const x=((W-w)>>1), y=((H-h)>>1); ctx2d.imageSmoothingEnabled=true; ctx2d.drawImage(img,x,y,w,h); ctx2d.restore(); }
  function sampleRGBA(imgData, x, y, W){ const i=((y*W)+x)*4, d=imgData.data; return [d[i], d[i+1], d[i+2], d[i+3]]; }
  function rgbaStr(c){ return `rgba(${c[0]|0}, ${c[1]|0}, ${c[2]|0}, ${(Math.max(0,Math.min(1,c[3]/255))).toFixed(3)})`; }
  function lerp(a,b,t){ return a + (b-a)*t; }
  function lerpColor(c1,c2,t){ return [ lerp(c1[0],c2[0],t), lerp(c1[1],c2[1],t), lerp(c1[2],c2[2],t), 255 ]; }
  function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
  function approxGradientDir(grad, x, y, W, H){ let best=0,bx=0,by=0; for (let j=-1;j<=1;j++){ for (let i=-1;i<=1;i++){ if (!i && !j) continue; const xx=clamp(x+i,0,W-1), yy=clamp(y+j,0,H-1); const v=grad[yy*W+xx]; if (v>best){ best=v; bx=i; by=j; }}} const len=Math.hypot(bx,by)||1; return { x:bx/len, y:by/len }; }
  function sobelMagnitude(imgData, W, H, boost=1){ const g=new Float32Array(W*H), lum=new Float32Array(W*H), d=imgData.data;
    for(let i=0,p=0;i<d.length;i+=4,p++){ lum[p]=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; }
    for(let y=1;y<H-1;y++){ for(let x=1;x<W-1;x++){ const idx=y*W+x; const l=(dx,dy)=> lum[(y+dy)*W + (x+dx)];
      const gx=-l(1,-1)-2*l(1,0)-l(1,1)+l(-1,-1)+2*l(-1,0)+l(-1,1);
      const gy= l(-1,1)+2*l(0,1)+l(1,1) - l(-1,-1) -2*l(0,-1) - l(1,-1);
      g[idx]=Math.sqrt(gx*gx+gy*gy)*boost; }}
    let max=1e-6; for(let i=0;i<g.length;i++) if(g[i]>max) max=g[i];
    const inv=255/max; for(let i=0;i<g.length;i++) g[i]*=inv; return g;
  }
})();
