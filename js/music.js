// music.js — tiny bottom-left music player (Material Symbols controls + calmer viz + K/S/H)
// Publishes window.__AUDIO_BUS and a public window.__MUSIC_API with:
//   addFiles(files[]), setTrackIndex(i), removeAt(i), getPlaylist(),
//   on(event, fn), off(event, fn), isReady, isPlaying, play(), toggle(),
//   seekTo(t), nudge(sec), currentTime, duration
//
// NOTE: Paths are GitHub Pages–safe via MUSIC_BASE. To override at runtime, set:
//   window.__MUSIC_BASE = '/my-site/music/';

const MUSIC_BASE = (window.__MUSIC_BASE || './music/').replace(/\/+$/, '') + '/';

/* ---------- small helpers ---------- */
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mk = (tag, style = {}) => { const el = document.createElement(tag); Object.assign(el.style, style); return el; };

const UI = { text:'#e6e8f0', white:'#ffffff' };
const SIZE = {
  leftPad: 18,
  gapY: 11,
  dot: 12, // Reduced from 18 to 12 (3px smaller radius)
  W: 240,
  vizH: 56,
  barGap: 2,
  kshH: 6,
};

/* ---------- mobile guard ---------- */
const MOBILE_MAX_WIDTH = 800;
const isMobileViewport = () =>
  (window.innerWidth || document.documentElement.clientWidth || 0) <= MOBILE_MAX_WIDTH;

/* ====== SENSITIVITY CONTROLS ====== */
const VISUALIZER_SCALE = 0.90;
const VISUALIZER_SENS = 1.12;
const ANALYSER_SMOOTHING = 0.75;

const DRUM_THR = { kick:0.040, snare:0.050, hat:0.030 };
const DRUM_COOLDOWN_MS = 60;
const DRUM_HIT_BOOST = 0.90;
const DRUM_DECAY = 0.02;

/* ================================== */

let audio, ctx, sourceNode, analyser, gainNode;
let dataFreq, dataTime;
let playlist = [];          // [{id, title, src, kind:'file'|'net'}]
let trackIdx = 0;
let isPlaying = false;
let rafId = 0;
let _ui = {};               // caches for UI bits used in render
let _events = {};           // simple event bus

const features = { bands:{}, rms:0, kick:0, snare:0, hat:0 };
const _prevSubband = { kick:null, snare:null, hat:null };
const _kshCooldown = { kick:0, snare:0, hat:0 };

/* ---------- AUDIO BUS PUBLISHER ---------- */
function publishAudioBus() {
  if (!window.__AUDIO_BUS) window.__AUDIO_BUS = {
    rms: 0, playing: false,
    bands: { bass:0, mid:0, treble:0 },
    kick: 0, snare: 0, hat: 0,
  };
  const bus = window.__AUDIO_BUS;
  bus.rms = clamp01(features.rms);
  bus.playing = !!isPlaying;
  bus.bands.bass   = clamp01(features.bands.bass   || 0);
  bus.bands.mid    = clamp01(features.bands.mid    || 0);
  bus.bands.treble = clamp01(features.bands.treble || 0);
  bus.kick  = clamp01(features.kick);
  bus.snare = clamp01(features.snare);
  bus.hat   = clamp01(features.hat);
}

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
      font-size: 13px;
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

/* ---------- playlist bootstrap ---------- */
async function loadPlaylist() {
  try {
    const res = await fetch(MUSIC_BASE + 'manifest.json', { cache:'no-store' });
    if (res.ok) {
      const list = await res.json();
      const out = [];
      for (const item of list) {
        if (typeof item === 'string') out.push({ id: crypto.randomUUID?.() || String(out.length), file:item, title:item, src:(/^(?:https?:)?\/\//i.test(item)? item : MUSIC_BASE + item), kind:'net' });
        else if (item && item.file) {
          const src = /^(?:https?:)?\/\//i.test(item.file) ? item.file : (MUSIC_BASE + item.file);
          out.push({ id: crypto.randomUUID?.() || String(out.length), title:(item.title||item.file), src, kind:'net' });
        }
      }
      if (out.length) { playlist = out; return; }
    }
  } catch {}
  try {
    const head = await fetch(MUSIC_BASE + 'default.mp3', { method:'HEAD' });
    if (head.ok) {
      playlist = [{ id: 'default', title: 'default', src: MUSIC_BASE + 'default.mp3', kind:'net' }];
      return;
    }
  } catch {}
  // no tracks; start empty (upload will fill)
}

/* ---------- public API (event bus) ---------- */
function on(evt, fn){ (_events[evt] ||= new Set()).add(fn); }
function off(evt, fn){ _events[evt]?.delete(fn); }
function emit(evt, payload){ (_events[evt]||[]).forEach(fn => { try { fn(payload); } catch(_){} }); }

/* ---------- audio graph ---------- */
async function ensureAudioContext() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  gainNode = ctx.createGain();
  gainNode.gain.value = 0.30;

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

function currentTrack() { return playlist[trackIdx]; }

function loadTrack(autoplay, onTitle) {
  const t = currentTrack();
  if (!t) { audio.removeAttribute('src'); audio.load(); return; }
  audio.src = t.src; audio.load();
  onTitle?.();
  emit('titlechange', { title: t.title || '' });
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

function aWeighting(hz) {
  if (hz <= 0) return 0;
  const f2 = hz * hz;
  const num = (12194**2) * f2 * f2;
  const den = (f2 + 20.6**2) * Math.sqrt((f2 + 107.7**2) * (f2 + 737.9**2)) * (f2 + 12194**2);
  return num / den; // linear
}

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

  // drums via spectral flux + cooldown
  const bands = { kick:[40,120], snare:[180,2500], hat:[5000,12000] };
  const dt = 16;
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

    const thr = DRUM_THR[k];
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

/* Build 24 log-ish bands with extra resolution 2–10 kHz */
function buildBandEdges(count) {
  const edges = [];
  const lo = 40, hi = 12000;
  for (let i=0;i<=count;i++){
    const t = i/count;
    const bias = 0.55;
    const tb = Math.pow(t, 1 - (bias - 0.5) * 0.8);
    edges.push(lo * Math.pow(hi/lo, tb));
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
    position:'fixed', left:`${SIZE.leftPad}px`, bottom:'16px', zIndex:'900',
    display:'flex', flexDirection:'column', gap:`${SIZE.gapY}px`,
    color:UI.text, userSelect:'none',
    fontFamily:'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
    pointerEvents:'auto', isolation:'isolate'
  });
  host.id = 'music-host';

  // Hide on mobile
  if (isMobileViewport()) {
    host.style.display = 'none';
  }

  document.body.appendChild(host);

  const column = mk('div', {
    width: `${SIZE.W}px`, display:'flex', flexDirection:'column',
    gap:`${SIZE.gapY}px`, pointerEvents:'none', boxSizing:'border-box'
  });
  host.appendChild(column);

  // --- visualizer ---
  const vizBox = mk('div', { width:'100%', pointerEvents:'none', boxSizing:'border-box' });

  const barsWrap = mk('div', { position:'relative', width:'100%', height:`${SIZE.vizH}px` });
  const bars = [];   // create ONCE
  const caps = [];
  const bandCount = 24;

  const gapsTotal = SIZE.barGap * (bandCount - 1);
  const usable = SIZE.W - gapsTotal;
  const barW = Math.floor(usable / bandCount);
  const remainder = usable - barW * bandCount;

  const minH = 0; // Start at 0 height (hidden until music plays)

  for (let i=0;i<bandCount;i++){
    const extra = (i === bandCount - 1) ? remainder : 0;
    const widthPx = barW + extra;
    const x = i*(barW + SIZE.barGap);

    const bar = mk('div', {
      position:'absolute', bottom:'0', left:`${x}px`, width:`${widthPx}px`,
      height:`${minH}px`, background:UI.white, opacity:'0', pointerEvents:'none'
    });
    const cap = mk('div', {
      position:'absolute', left:`${x}px`, width:`${widthPx}px`, height:'2px',
      background:UI.white, opacity:'0', bottom:'0', pointerEvents:'none' // Start hidden
    });
    barsWrap.appendChild(bar); barsWrap.appendChild(cap);
    bars.push(bar); caps.push(cap);
  }

  vizBox.appendChild(barsWrap);

  // save onto _ui for reuse in render
  _ui.barsWrap = barsWrap;
  _ui.bars = bars;
  _ui.caps = caps;
  _ui.bandEdges = buildBandEdges(bandCount);
  _ui.capsPeak = new Array(bandCount).fill(0);
  _ui.capsHold = new Array(bandCount).fill(0);

  // --- K/S/H meters ---
  const kshWrap = mk('div', {
    display:'grid', gridTemplateColumns:'1fr 1fr 1fr', alignItems:'center',
    gap:'6px', width:'100%', height:`${SIZE.kshH + 4}px`, marginTop:`${SIZE.gapY}px`
  });
  const mkMeter = () => {
    const box = mk('div', { height:`${SIZE.kshH}px`, background:'rgba(255,255,255,0.15)', position:'relative' });
    const fill = mk('div', { height:'100%', width:'0%', background:UI.white, opacity:'0.9' });
    box.appendChild(fill); return { box, fill };
  };
  const k = mkMeter(), s = mkMeter(), h = mkMeter();
  kshWrap.appendChild(k.box); kshWrap.appendChild(s.box); kshWrap.appendChild(h.box);

  vizBox.appendChild(kshWrap);

  // --- sliders ---
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

  // progress (thin) - same size dot as controls
  const { rail:progRail, input:prog } = makeRailRange(3, SIZE.dot, 'progress', 'music-prog');
  prog.min='0'; prog.max='1'; prog.step='0.001'; prog.value='0';

  // track & thumb same color
  {
    const PROG_GRAY = '#9aa0a6';
    const css = document.createElement('style');
    css.textContent = `
      #music-host input[type="range"].music-prog::-webkit-slider-runnable-track { background: ${PROG_GRAY} !important; }
      #music-host input[type="range"].music-prog::-webkit-slider-thumb { background: ${PROG_GRAY} !important; }
      #music-host input[type="range"].music-prog::-moz-range-track { background: ${PROG_GRAY} !important; }
      #music-host input[type="range"].music-prog::-moz-range-thumb { background: ${PROG_GRAY} !important; }
    `;
    document.head.appendChild(css);
  }

  // controls row
  const row = mk('div', {
    width:`${SIZE.W}px`, display:'flex', alignItems:'center',
    gap:'10px', pointerEvents:'auto', boxSizing:'border-box'
  });

  const dotBtn = (title, iconName) => {
    const b = mk('div', {
      width: `${SIZE.dot}px`, height: `${SIZE.dot}px`, aspectRatio:'1 / 1',
      borderRadius:'50%', border:`1px solid ${UI.text}`, background:'transparent', color:UI.text,
      display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer',
      boxSizing:'border-box', lineHeight:'1', userSelect:'none', flex:'0 0 auto'
    });
    b.title = title || '';
    b.setAttribute('role','button'); b.setAttribute('tabindex','0');
    const span = document.createElement('span'); span.className = 'ms-icn'; span.textContent = iconName;
    b.appendChild(span); b._iconSpan = span;
    b.addEventListener('keydown', (e) => { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); b.click(); }});
    return b;
  };

  const prevBtn = dotBtn('Previous','arrow_back_ios_new');
  const playBtn = dotBtn('Play/Pause','play_arrow');
  const nextBtn = dotBtn('Next','arrow_forward_ios');

  // 100px marquee title
  const titleBox = mk('div', { width:'100px', overflow:'hidden', whiteSpace:'nowrap', position:'relative', flex:'0 0 auto' });
  const titleInner = mk('div', {
    display:'inline-block', paddingLeft:'100%', animation:'music-marquee 10s linear infinite',
    fontSize:'11px', opacity:'0.95'
  });
  titleBox.appendChild(titleInner);

  // volume rail - minimal with fill indicator
  const volHeight = Math.round(SIZE.dot / 2);
  const volContainer = mk('div', { position:'relative', width:`${SIZE.W}px`, height:`${volHeight}px` });

  // Background track
  const volTrack = mk('div', {
    position:'absolute', top:'0', left:'0', width:'100%', height:`${volHeight}px`,
    background:'rgba(255,255,255,0.22)', borderRadius:'999px'
  });

  // Fill indicator
  const volFill = mk('div', {
    position:'absolute', top:'0', left:'0', width:'30%', height:`${volHeight}px`,
    background:'#ffffff', borderRadius:'999px', pointerEvents:'none'
  });

  // Invisible slider on top
  const vol = mk('input');
  vol.type = 'range';
  vol.min='0'; vol.max='1'; vol.step='0.01'; vol.value='0.30';
  Object.assign(vol.style, {
    position:'absolute', top:'0', left:'0', width:'100%', height:`${volHeight}px`,
    opacity:'0', cursor:'pointer', margin:'0'
  });

  volContainer.appendChild(volTrack);
  volContainer.appendChild(volFill);
  volContainer.appendChild(vol);

  // Update fill on input
  vol.addEventListener('input', () => {
    const percent = (Number(vol.value) * 100).toFixed(1);
    volFill.style.width = `${percent}%`;
  });

  row.appendChild(prevBtn);
  row.appendChild(playBtn);
  row.appendChild(nextBtn);
  row.appendChild(titleBox);
  row.appendChild(volContainer);

  // assemble
  column.appendChild(vizBox);
  column.appendChild(progRail);
  column.appendChild(row);

  const kf = document.createElement('style');
  kf.textContent = `@keyframes music-marquee { 0% { transform: translateX(0%); } 100% { transform: translateX(-100%); } }`;
  document.head.appendChild(kf);

  /* ----- wiring ----- */
  const updateTitle = () => {
    const t = currentTrack();
    const txt = t ? (t.title || '') : '';
    titleInner.textContent = txt;
    titleInner.style.animation = 'none'; void titleInner.offsetWidth;
    titleInner.style.animation = 'music-marquee 10s linear infinite';
    emit('titlechange', { title: txt });
  };
  _ui.updateTitle = updateTitle;

  prevBtn.addEventListener('click', () => {
    if (!playlist.length) return;
    trackIdx = (trackIdx - 1 + playlist.length) % playlist.length;
    const auto = isPlaying; loadTrack(auto, updateTitle);
    notifyPlaylist();
  });
  nextBtn.addEventListener('click', () => {
    if (!playlist.length) return;
    trackIdx = (trackIdx + 1) % playlist.length;
    const auto = isPlaying; loadTrack(auto, updateTitle);
    notifyPlaylist();
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
    publishAudioBus();
    emit('state', { playing: isPlaying });
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
  const capsPeak = _ui.capsPeak;
  const capsHold = _ui.capsHold;
  const bandEdges = _ui.bandEdges;

  const barsRef = _ui.bars; // reuse
  const capsRef = _ui.caps;

  const PEAK_HOLD_MS = 160;
  const PEAK_FALL = 0.05;

  function frame() {
    if (analyser && !audio.paused && !audio.ended) {
      updateFeatures();
      publishAudioBus();

      for (let i=0;i<bandEdges.length-1;i++){
        const lo = bandEdges[i], hi = bandEdges[i+1];
        let v = subbandEnergyWeighted(lo, hi);
        const center = Math.sqrt(lo * hi);
        const autoGain = 1 + Math.min(1.0, Math.pow(center / 3200, 0.30));
        v = Math.min(1, v * autoGain);

        const vScaled = Math.min(1, v * VISUALIZER_SCALE);
        const HEADROOM = 0.85;
        const h = Math.round(2 + vScaled * (SIZE.vizH - 6) * HEADROOM);

        barsRef[i].style.height = `${h}px`;
        barsRef[i].style.opacity = String(0.45 + vScaled * 0.5);

        const now = performance.now();
        if (vScaled > capsPeak[i]) { capsPeak[i]=vScaled; capsHold[i]=now+PEAK_HOLD_MS; }
        else if (now > capsHold[i]) { capsPeak[i] = Math.max(0, capsPeak[i]-PEAK_FALL); }

        const capH = Math.round(2 + capsPeak[i]*(SIZE.vizH - 6) * HEADROOM);
        capsRef[i].style.bottom = Math.max(capH - 2, 0) + 'px';
        capsRef[i].style.opacity = String(0.85); // Show caps when music plays
      }

      // K/S/H meters
      const kW = Math.round(clamp01(features.kick  * VISUALIZER_SCALE)*100);
      const sW = Math.round(clamp01(features.snare * VISUALIZER_SCALE)*100);
      const hW = Math.round(clamp01(features.hat   * VISUALIZER_SCALE)*100);
      k.fill.style.width = `${kW}%`;
      s.fill.style.width = `${sW}%`;
      h.fill.style.width = `${hW}%`;
    } else {
      publishAudioBus();
    }
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  return { updateTitle, playBtn, host };
}

/* ---------- public init ---------- */
export async function initMusicPlayer() {
  // Remove any existing music host first
  const existing = document.getElementById('music-host');
  if (existing) existing.remove();

  // initialize a default bus so listeners don't fail before audio starts
  publishAudioBus();

  // Mobile guard: disable UI + graph on small viewports (800px and below)
  if (isMobileViewport()) {
    if (window.__AUDIO_BUS) {
      window.__AUDIO_BUS.playing = false;
      window.__AUDIO_BUS.rms = 0;
      window.__AUDIO_BUS.bands.bass = 0;
      window.__AUDIO_BUS.bands.mid = 0;
      window.__AUDIO_BUS.bands.treble = 0;
      window.__AUDIO_BUS.kick = 0;
      window.__AUDIO_BUS.snare = 0;
      window.__AUDIO_BUS.hat = 0;
    }
    window.__AUDIO_DISABLED = true;
    // Still expose a stub API for middleui
    buildAPI(true);
    return; // Don't create UI on mobile
  }

  window.__AUDIO_DISABLED = false;

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
    publishAudioBus();
    emit('state', { playing: isPlaying });
  });
  audio.addEventListener('pause', () => {
    isPlaying = false;
    if (playBtn && playBtn._iconSpan) playBtn._iconSpan.textContent = 'play_arrow';
    publishAudioBus();
    emit('state', { playing: isPlaying });
  });
  audio.addEventListener('ended', () => {
    if (!playlist.length) return;
    trackIdx = (trackIdx + 1) % playlist.length;
    loadTrack(true, _ui.updateTitle);
    notifyPlaylist();
  });

  window.addEventListener('beforeunload', () => {
    try { cancelAnimationFrame(rafId); } catch {}
    try { audio.pause(); } catch {}
    try { ctx && ctx.close && ctx.close(); } catch {}
    isPlaying = false;
    publishAudioBus();
  });

  buildAPI(false);
}

/* ---------- API & helpers used by middleui ---------- */

function notifyPlaylist(){
  const api = window.__MUSIC_API;
  if (!api) return;
  emit('playlistchange', { items: api.getPlaylist ? api.getPlaylist() : [] });
}

function buildAPI(isStub){
  const api = {
    get isReady(){ return !!audio; },
    get isPlaying(){ return !!isPlaying; },
    play: () => audio?.play?.().catch(()=>{}),
    toggle: async () => {
      await ensureAudioContext();
      if (!audio) return;
      if (audio.paused) { await audio.play().catch(()=>{}); }
      else { audio.pause(); }
    },
    seekTo: (t) => {
      if (!audio || !isFinite(t)) return;
      const d = audio.duration || 0;
      if (d > 0) audio.currentTime = clamp(t, 0, d);
    },
    nudge: (sec) => {
      if (!audio || !isFinite(sec)) return;
      const d = audio.duration || 0;
      if (d > 0) audio.currentTime = clamp((audio.currentTime||0) + sec, 0, d);
    },
    get currentTime(){ return audio?.currentTime || 0; },
    get duration(){ return audio?.duration || 0; },

    addFiles: (files=[]) => {
      // append uploaded files to playlist
      const added = [];
      for (const f of files) {
        if (!f || !/audio\//i.test(f.type || '') && !/\.(mp3|wav|ogg|m4a|aac)$/i.test(f.name||'')) continue;
        const url = URL.createObjectURL(f);
        added.push({
          id: crypto.randomUUID?.() || (Date.now() + '_' + Math.random().toString(36).slice(2)),
          title: f.name || 'upload',
          src: url,
          kind: 'file',
          _blob: url
        });
      }
      if (!added.length) return;

      const hadNone = playlist.length === 0;
      playlist.push(...added);

      if (hadNone) {
        trackIdx = 0;
        loadTrack(true, _ui.updateTitle);
      } else {
        // don’t switch track; just notify
        notifyPlaylist();
      }
    },

    setTrackIndex: (i) => {
      if (!playlist.length) return;
      trackIdx = Math.max(0, Math.min(playlist.length-1, i|0));
      loadTrack(true, _ui.updateTitle);
      notifyPlaylist();
    },

    removeAt: (i) => {
      if (i<0 || i>=playlist.length) return;
      // revoke blobs if any
      const it = playlist[i];
      if (it && it.kind==='file' && it._blob) { try { URL.revokeObjectURL(it._blob); } catch {} }

      playlist.splice(i,1);

      if (trackIdx >= playlist.length) trackIdx = Math.max(0, playlist.length-1);
      if (playlist.length) {
        loadTrack(false, _ui.updateTitle);
      } else {
        // empty
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        isPlaying = false;
        publishAudioBus();
        emit('state', { playing: isPlaying });
      }
      notifyPlaylist();
    },

    getPlaylist: () => playlist.map(({id,title,src}) => ({ id, title, src })),

    on, off,
    _emit: emit
  };
  window.__MUSIC_API = api;
}

/* ---------- default export ---------- */
export default initMusicPlayer;
