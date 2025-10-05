// music.js — tiny bottom-left music player (Material Symbols controls + calmer viz + K/S/H)
// Tweaks: progress bar is thin (3px) and vertical gaps are 11px
// Updates:
//  - Progress rail + thumb: same solid gray (no overlap)
//  - Visualizer: slightly more sensitive to changes
//  - Drums (K/S/H): much more sensitive + quicker retrigger

/* ---------- small helpers ---------- */
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mk = (tag, style = {}) => { const el = document.createElement(tag); Object.assign(el.style, style); return el; };

const UI = { text:'#e6e8f0', white:'#ffffff' };
const SIZE = {
  leftPad: 18,
  gapY: 11,      // +3px vs before
  dot: 18,
  W: 240,
  vizH: 56,
  barGap: 2,
  kshH: 6,
};

/* ====== SENSITIVITY CONTROLS (tweak these) ====== */
// overall visualizer intensity scaler (bars + K/S/H width)
// raised slightly from 0.85 -> 0.90 to be a touch stronger
const VISUALIZER_SCALE = 0.90;

// gentle pre-gain applied to subband energy before scaling
// increases responsiveness without making it too peaky
const VISUALIZER_SENS = 1.12;

// analyser smoothing: lower = more responsive (was 0.82)
const ANALYSER_SMOOTHING = 0.75;

// Drum detection (spectral flux) thresholds (lower = more sensitive)
const DRUM_THR = {
  kick:  0.040, // was ~0.06 (global), now lower → more hits
  snare: 0.050,
  hat:   0.030
};

// Drum retrigger cooldown in milliseconds (was ~90 ms)
const DRUM_COOLDOWN_MS = 60;

// Amount added on hit and per-frame decay (lower decay = holds slightly longer)
const DRUM_HIT_BOOST = 0.90; // was 0.75
const DRUM_DECAY     = 0.02; // was 0.03

/* ================================================ */

let audio, ctx, sourceNode, analyser, gainNode;
let dataFreq, dataTime;
let playlist = [];
let trackIdx = 0;
let isPlaying = false;
let rafId = 0;

const features = { bands:{}, rms:0, kick:0, snare:0, hat:0 };
const _prevSubband = { kick:null, snare:null, hat:null };
const _kshCooldown = { kick:0, snare:0, hat:0 };

/* ---------- material symbols (icons) ---------- */
function ensureMaterialSymbols() {
  if (document.getElementById('ms-font-link')) return;
  const link = document.createElement('link');
  link.id = 'ms-font-link';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0,0';
  document.head.appendChild(link);

  const css = document.createElement('style');
  css.textContent = `
    #music-host .ms-icn {
      font-family: 'Material Symbols Outlined';
      font-weight: 400;
      font-style: normal;
      font-size: 13px; /* fits inside 18px circle */
      line-height: 1;
      display: inline-block;
      font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
      color: ${UI.white};
      pointer-events: none;
      transform: translateY(0.5px);
    }
  `;
  document.head.appendChild(css);
}

/* ---------- playlist ---------- */
async function loadPlaylist() {
  try {
    const res = await fetch('/music/manifest.json', { cache:'no-store' });
    if (res.ok) {
      const list = await res.json();
      const out = [];
      for (const item of list) {
        if (typeof item === 'string') out.push({ file:item, title:item });
        else if (item && item.file) out.push({ ...item });
      }
      if (out.length) { playlist = out; return; }
    }
  } catch {}
  try {
    const head = await fetch('/music/default.mp3', { method:'HEAD' });
    if (head.ok) { playlist = [{ file:'default.mp3', title:'default' }]; return; }
  } catch {}
  console.warn('[music] no tracks found. Provide /music/manifest.json or /music/default.mp3');
}

function currentTrackUrl() {
  const t = playlist[trackIdx]; if (!t) return null;
  const file = t.file || t.url || '';
  if (/^(?:https?:)?\/\//i.test(file)) return file;
  return `/music/${file}`;
}

/* ---------- audio graph ---------- */
async function ensureAudioContext() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  gainNode = ctx.createGain();
  gainNode.gain.value = 0.30; // default 30%

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;

  dataFreq = new Uint8Array(analyser.frequencyBinCount);
  dataTime = new Uint8Array(analyser.fftSize);

  sourceNode = ctx.createMediaElementSource(audio);
  sourceNode.connect(gainNode);
  gainNode.connect(analyser);
  analyser.connect(ctx.destination);
}

function loadTrack(autoplay, onTitle) {
  const url = currentTrackUrl(); if (!url) return;
  audio.src = url; audio.load();
  onTitle?.(); // update title immediately
  if (autoplay) {
    const go = () => audio.play().catch(()=>{});
    if (ctx && ctx.state === 'suspended') ctx.resume().then(go); else go();
  }
}

/* ---------- analysis helpers ---------- */
function hzToIndex(hz) {
  const sr = ctx?.sampleRate || 44100;
  const binHz = sr / analyser.fftSize;
  let i = Math.round(hz / binHz);
  const max = analyser.frequencyBinCount - 1;
  if (!isFinite(i)) i = 0;
  return Math.max(0, Math.min(max, i));
}

/* A-weighting curve (approx) to emphasize human hearing; used gently */
function aWeighting(hz) {
  if (hz <= 0) return 0;
  const f2 = hz * hz;
  const num = (12194**2) * f2 * f2;
  const den = (f2 + 20.6**2) * Math.sqrt((f2 + 107.7**2) * (f2 + 737.9**2)) * (f2 + 12194**2);
  const A = num / den;
  return A;
}

/* Weighted energy for a band, with gentle tilt and compression & overall trim */
function subbandEnergyWeighted(loHz, hiHz) {
  const i0 = hzToIndex(loHz), i1 = hzToIndex(hiHz);
  let ws = 0, wsum = 0;
  const sr = ctx?.sampleRate || 44100;
  const binHz = sr / analyser.fftSize;

  for (let i = i0; i <= i1; i++) {
    const hz = i * binHz;
    const tilt = 0.85 + Math.min(1.25, Math.pow(hz / 3500, 0.28));
    const w = aWeighting(hz) * tilt;
    ws += (dataFreq[i] / 255) * w;
    wsum += w;
  }
  let v = wsum ? (ws / wsum) : 0;

  // slightly less compression: keep the 0.75 exponent but add gentle pre-gain
  v = Math.pow(v, 0.75) * 0.9;
  v *= VISUALIZER_SENS;

  return v;
}

function updateFeatures() {
  analyser.getByteFrequencyData(dataFreq);
  analyser.getByteTimeDomainData(dataTime);

  features.bands.bass    = subbandEnergyWeighted( 20, 120);
  features.bands.lowMid  = subbandEnergyWeighted(120, 300);
  features.bands.mid     = subbandEnergyWeighted(300, 1200);
  features.bands.highMid = subbandEnergyWeighted(1200, 4000);
  features.bands.treble  = subbandEnergyWeighted(4000, 12000);

  // RMS
  let sum=0; for (let i=0;i<dataTime.length;i++){ const v=(dataTime[i]-128)/128; sum+=v*v; }
  features.rms = Math.sqrt(sum/dataTime.length);

  // drum heuristics via subband spectral flux + cooldown
  const bands = { kick:[40,120], snare:[180,2500], hat:[5000,12000] };
  const dt = 16; // ~frame delta (ms)

  for (const k of ['kick','snare','hat']) {
    const [lo,hi] = bands[k];
    const i0 = hzToIndex(lo), i1 = hzToIndex(hi);
    if (!_prevSubband[k]) _prevSubband[k] = new Float32Array(i1 - i0 + 1);

    let flux=0, n=0;
    for (let i=i0,j=0; i<=i1; i++,j++){
      const cur = dataFreq[i]/255, prev = _prevSubband[k][j]||0;
      const d = cur - prev; if (d>0) flux += d;
      _prevSubband[k][j] = cur; n++;
    }
    flux = n ? flux/n : 0;

    const thr = DRUM_THR[k];                     // lower thresholds
    const hit = flux > thr && _kshCooldown[k] <= 0;

    if (hit) {
      features[k] = Math.min(1, features[k] + DRUM_HIT_BOOST);
      _kshCooldown[k] = DRUM_COOLDOWN_MS;
    } else {
      features[k] = Math.max(0, features[k] - DRUM_DECAY);
      _kshCooldown[k] = Math.max(0, _kshCooldown[k] - dt);
    }
  }
}

/* Build 24 log-ish bands with extra resolution in 2–10 kHz */
function buildBandEdges(count) {
  const edges = [];
  const lo = 40, hi = 12000;
  for (let i=0;i<=count;i++){
    const t = i/count;
    const bias = 0.55;
    const tb = Math.pow(t, 1 - (bias - 0.5) * 0.8);
    const hz = lo * Math.pow(hi/lo, tb);
    edges.push(hz);
  }
  edges[edges.length-2] *= 1.15;
  edges[edges.length-1] = hi;
  return edges;
}

/* ---------- UI ---------- */
function buildUI() {
  document.getElementById('music-host')?.remove();
  ensureMaterialSymbols();

  const host = mk('div', {
    position:'fixed', left:`${SIZE.leftPad}px`, bottom:'16px', zIndex:'99991',
    display:'flex', flexDirection:'column', gap:`${SIZE.gapY}px`,
    color:UI.text, userSelect:'none',
    fontFamily:'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
    pointerEvents:'auto', isolation:'isolate'
  });
  host.id = 'music-host';
  document.body.appendChild(host);

  const column = mk('div', {
    width: `${SIZE.W}px`, display:'flex', flexDirection:'column',
    gap:`${SIZE.gapY}px`, pointerEvents:'none', boxSizing:'border-box'
  });
  host.appendChild(column);

  // --- visualizer (bars + K/S/H meters) ---
  const vizBox = mk('div', { width:'100%', pointerEvents:'none', boxSizing:'border-box' });

  const barsWrap = mk('div', { position:'relative', width:'100%', height:`${SIZE.vizH}px` });
  const bars = [], caps = [];
  const bandCount = 24;

  const gapsTotal = SIZE.barGap * (bandCount - 1);
  const usable = SIZE.W - gapsTotal;
  const barW = Math.floor(usable / bandCount);
  const remainder = usable - barW * bandCount;

  const minH = 2;

  for (let i=0;i<bandCount;i++){
    const extra = (i === bandCount - 1) ? remainder : 0;
    const widthPx = barW + extra;
    const x = i*(barW + SIZE.barGap);

    const bar = mk('div', {
      position:'absolute', bottom:'0', left:`${x}px`, width:`${widthPx}px`,
      height:`${minH}px`, background:UI.white, opacity:'0.6', pointerEvents:'none'
    });
    const cap = mk('div', {
      position:'absolute', left:`${x}px`, width:`${widthPx}px`, height:'2px',
      background:UI.white, opacity:'0.85', bottom:'0', pointerEvents:'none'
    });
    barsWrap.appendChild(bar); barsWrap.appendChild(cap);
    bars.push(bar); caps.push(cap);
  }

  const kshWrap = mk('div', {
    display:'grid', gridTemplateColumns:'1fr 1fr 1fr', alignItems:'center',
    gap:'6px', width:'100%', height:`${SIZE.kshH + 4}px`, marginTop:'4px'
  });
  const mkMeter = () => {
    const box = mk('div', { height:`${SIZE.kshH}px`, background:'rgba(255,255,255,0.15)', position:'relative' });
    const fill = mk('div', { height:'100%', width:'0%', background:UI.white, opacity:'0.9' });
    box.appendChild(fill); return { box, fill };
  };
  const k = mkMeter(), s = mkMeter(), h = mkMeter();
  kshWrap.appendChild(k.box); kshWrap.appendChild(s.box); kshWrap.appendChild(h.box);

  vizBox.appendChild(barsWrap);
  vizBox.appendChild(kshWrap);

  // --- slider rails (scoped CSS per slider) ---
  function makeRailRange(heightPx, thumbPx, ariaLabel, clsName) {
    const rail = mk('div', { width:`${SIZE.W}px`, pointerEvents:'none' });
    const input = mk('input', { width:'100%', boxSizing:'border-box', pointerEvents:'auto' });
    input.type = 'range';
    input.className = clsName || '';
    Object.assign(input.style, {
      height:`${heightPx}px`,
      background:'transparent',
      outline:'none',
      appearance:'none',
      cursor:'pointer',
      margin:'0',
      display:'block'
    });
    input.setAttribute('aria-label', ariaLabel || 'slider');

    const thumbMarginTop = -Math.round((thumbPx - heightPx) / 2);
    const css = document.createElement('style');
    css.textContent = `
      #music-host input[type="range"].${clsName}::-webkit-slider-runnable-track {
        height:${heightPx}px; background:rgba(255,255,255,0.22); border-radius:999px; border:none;
      }
      #music-host input[type="range"].${clsName}::-webkit-slider-thumb {
        -webkit-appearance:none; width:${thumbPx}px; height:${thumbPx}px;
        border-radius:50%; background:#ffffff; border:none;
        margin-top:${thumbMarginTop}px;
      }
      #music-host input[type="range"].${clsName}::-moz-range-track {
        height:${heightPx}px; background:rgba(255,255,255,0.22); border-radius:999px; border:none;
      }
      #music-host input[type="range"].${clsName}::-moz-range-thumb {
        width:${thumbPx}px; height:${thumbPx}px; border-radius:50%; background:#ffffff; border:none;
      }
    `;
    document.head.appendChild(css);

    rail.appendChild(input);
    return { rail, input };
  }

  // progress (height 3px — thin) with its own class
  const { rail:progRail, input:prog } = makeRailRange(3, SIZE.dot - 4, 'progress', 'music-prog');
  prog.min='0'; prog.max='1'; prog.step='0.001'; prog.value='0';

  // Make progress rail + thumb same solid gray to hide overlap
  {
    const PROG_GRAY = '#9aa0a6'; // adjust to taste
    const css = document.createElement('style');
    css.textContent = `
      #music-host input[type="range"].music-prog::-webkit-slider-runnable-track {
        background: ${PROG_GRAY} !important;
      }
      #music-host input[type="range"].music-prog::-webkit-slider-thumb {
        background: ${PROG_GRAY} !important;
      }
      #music-host input[type="range"].music-prog::-moz-range-track {
        background: ${PROG_GRAY} !important;
      }
      #music-host input[type="range"].music-prog::-moz-range-thumb {
        background: ${PROG_GRAY} !important;
      }
    `;
    document.head.appendChild(css);
  }

  // --- controls row ---
  const row = mk('div', {
    width:`${SIZE.W}px`, display:'flex', alignItems:'center',
    gap:'10px', pointerEvents:'auto', boxSizing:'border-box'
  });

  const dotBtn = (title, iconName) => {
    const b = mk('div', {
      width: `${SIZE.dot}px`,
      height: `${SIZE.dot}px`,
      aspectRatio: '1 / 1',
      borderRadius:'50%',
      border:`1px solid ${UI.text}`,
      background:'transparent',
      color:UI.text,
      display:'flex',
      alignItems:'center',
      justifyContent:'center',
      cursor:'pointer',
      boxSizing:'border-box',
      lineHeight:'1',
      userSelect:'none',
      flex: '0 0 auto'
    });
    b.title = title || '';
    b.setAttribute('role','button');
    b.setAttribute('tabindex','0');
    const span = document.createElement('span');
    span.className = 'ms-icn';
    span.textContent = iconName;
    b.appendChild(span);
    b._iconSpan = span;
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); }
    });
    return b;
  };

  const prevBtn = dotBtn('Previous','arrow_back_ios_new');
  const playBtn = dotBtn('Play/Pause','play_arrow');
  const nextBtn = dotBtn('Next','arrow_forward_ios');

  // 100px marquee title
  const titleBox = mk('div', {
    width:'100px', overflow:'hidden', whiteSpace:'nowrap', position:'relative', flex:'0 0 auto'
  });
  const titleInner = mk('div', {
    display:'inline-block', paddingLeft:'100%',
    animation:'music-marquee 10s linear infinite',
    fontSize:'11px', opacity:'0.95'
  });
  titleBox.appendChild(titleInner);

  // volume rail (height = dot/2) with its own class so it doesn’t override progress
  const volHeight = Math.round(SIZE.dot / 2);
  const { rail:volRail, input:vol } = makeRailRange(volHeight, SIZE.dot - 4, 'volume', 'music-vol');
  vol.min='0'; vol.max='1'; vol.step='0.01'; vol.value='0.30';

  row.appendChild(prevBtn);
  row.appendChild(playBtn);
  row.appendChild(nextBtn);
  row.appendChild(titleBox);
  row.appendChild(volRail);

  // assemble
  column.appendChild(vizBox);
  column.appendChild(progRail);
  column.appendChild(row);

  // marquee keyframes (scoped)
  const kf = document.createElement('style');
  kf.textContent = `@keyframes music-marquee { 0% { transform: translateX(0%); } 100% { transform: translateX(-100%); } }`;
  document.head.appendChild(kf);

  /* ----- wiring ----- */
  const updateTitle = () => {
    const t = playlist[trackIdx];
    titleInner.textContent = t ? (t.title || t.file || '') : '';
    titleInner.style.animation = 'none'; void titleInner.offsetWidth;
    titleInner.style.animation = 'music-marquee 10s linear infinite';
  };

  prevBtn.addEventListener('click', () => {
    if (!playlist.length) return;
    trackIdx = (trackIdx - 1 + playlist.length) % playlist.length;
    const auto = isPlaying; loadTrack(auto, updateTitle);
  });
  nextBtn.addEventListener('click', () => {
    if (!playlist.length) return;
    trackIdx = (trackIdx + 1) % playlist.length;
    const auto = isPlaying; loadTrack(auto, updateTitle);
  });
  playBtn.addEventListener('click', async () => {
    await ensureAudioContext();
    if (!playlist.length && !audio.src) return;
    if (audio.paused) {
      await audio.play().catch(()=>{});
      isPlaying = true;
      if (playBtn._iconSpan) playBtn._iconSpan.textContent = 'pause';
    } else {
      audio.pause();
      isPlaying = false;
      if (playBtn._iconSpan) playBtn._iconSpan.textContent = 'play_arrow';
    }
  });
  vol.addEventListener('input', () => { if (gainNode) gainNode.gain.value = Number(vol.value); });

  // progress sync + seek
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration || isNaN(audio.duration)) return;
    if (!prog.matches(':active')) prog.value = String(audio.currentTime / audio.duration);
  });
  prog.addEventListener('input', () => {
    if (!audio.duration || isNaN(audio.duration)) return;
    audio.currentTime = clamp01(Number(prog.value)) * audio.duration;
  });

  /* ----- render loop ----- */
  const bandEdges = buildBandEdges(bandCount);
  const capsPeak = new Array(bandCount).fill(0);
  const capsHold = new Array(bandCount).fill(0);
  const PEAK_HOLD_MS = 160;
  const PEAK_FALL = 0.05;

  function frame() {
    if (analyser && !audio.paused && !audio.ended) {
      updateFeatures();

      // >>> EXPOSE AUDIO BUS for visual effects (read-only snapshot)
      //     This lets videothreshold.js (and others) react to music.
      window.__AUDIO_BUS = {
        rms: features.rms,
        kick: features.kick, snare: features.snare, hat: features.hat,
        bands: { ...features.bands } // bass, lowMid, mid, highMid, treble
      };

      for (let i=0;i<bandCount;i++){
        const lo = bandEdges[i], hi = bandEdges[i+1];
        let v = subbandEnergyWeighted(lo, hi);

        const center = Math.sqrt(lo * hi);
        const autoGain = 1 + Math.min(1.0, Math.pow(center / 3200, 0.30));
        v = Math.min(1, v * autoGain);

        // intensity & scale
        const vScaled = Math.min(1, v * VISUALIZER_SCALE);

        const HEADROOM = 0.85;
        const h = Math.round(2 + vScaled * (SIZE.vizH - 6) * HEADROOM);

        bars[i].style.height = `${h}px`;
        bars[i].style.opacity = String(0.45 + vScaled * 0.5);

        const now = performance.now();
        if (vScaled > capsPeak[i]) { capsPeak[i]=vScaled; capsHold[i]=now+PEAK_HOLD_MS; }
        else if (now > capsHold[i]) { capsPeak[i] = Math.max(0, capsPeak[i]-PEAK_FALL); }

        const capH = Math.round(2 + capsPeak[i]*(SIZE.vizH - 6) * HEADROOM);
        caps[i].style.bottom = Math.max(capH - 2, 0) + 'px';
      }

      // also scale K/S/H meters
      const kW = Math.round(clamp01(features.kick  * VISUALIZER_SCALE)*100);
      const sW = Math.round(clamp01(features.snare * VISUALIZER_SCALE)*100);
      const hW = Math.round(clamp01(features.hat   * VISUALIZER_SCALE)*100);
      k.fill.style.width = `${kW}%`;
      s.fill.style.width = `${sW}%`;
      h.fill.style.width = `${hW}%`;
    }
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  return { updateTitle, playBtn };
}

/* ---------- public init ---------- */
export async function initMusicPlayer() {
  if (document.getElementById('music-host')) return;

  audio = document.createElement('audio');
  audio.preload = 'auto';
  audio.crossOrigin = 'anonymous';

  await loadPlaylist();
  const { updateTitle, playBtn } = buildUI();

  if (playlist.length) { loadTrack(false, updateTitle); }

  audio.addEventListener('play', async () => {
    await ensureAudioContext();
    isPlaying = true;
    if (playBtn && playBtn._iconSpan) playBtn._iconSpan.textContent = 'pause';
  });
  audio.addEventListener('pause', () => {
    isPlaying = false;
    if (playBtn && playBtn._iconSpan) playBtn._iconSpan.textContent = 'play_arrow';
  });
  audio.addEventListener('ended', () => {
    if (!playlist.length) return;
    trackIdx = (trackIdx + 1) % playlist.length;
    loadTrack(true, updateTitle);
  });

  window.addEventListener('beforeunload', () => {
    try { cancelAnimationFrame(rafId); } catch {}
    try { audio.pause(); } catch {}
    try { ctx && ctx.close && ctx.close(); } catch {}
  });
}

export default initMusicPlayer;
