// bg_perlin.js — c2.js Perlin background that reacts to music
// - Mounts its own fixed canvas behind p5
// - Fades in only when music is playing (or rms > threshold)
// - Audio reactivity: amplitude, curl, glow intensity
// - API used by videothreshold: attach(), detach(), resize(), update(), draw() (no-ops for p5)

const PAL = {
  // soft whites on your dark BG
  base: '#e6e8f0',
  bright: '#ffffff',
};

function _bus() {
  const b = window.__AUDIO_BUS || {};
  const clamp = v => Math.max(0, Math.min(1, v ?? 0));
  return {
    rms: clamp(b.rms),
    bands: {
      bass:   clamp(b.bands?.bass),
      mid:    clamp(b.bands?.mid),
      treble: clamp(b.bands?.treble),
    },
    playing: !!b.playing || (clamp(b.rms) > 0.015),
  };
}

export default class C2PerlinBG {
  constructor() {
    this.canvas = null;
    this.renderer = null;
    this.perlin = null;

    this.row = 22;
    this.col = 64;

    this.alpha = 0;          // current opacity (0..1)
    this.targetAlpha = 0;    // desired opacity
    this.fadeSlew = 0.12;    // fade speed

    this._onResize = this._onResize.bind(this);
  }

  /* ---------- lifecycle from VideoThreshold ---------- */
  attach() {
    // If c2.js is missing, quietly no-op.
    if (!window.c2) {
      console.warn('[bg_perlin] c2.js not found; background disabled.');
      return;
    }
    if (this.canvas) return;

    // Create behind p5
    const c = document.createElement('canvas');
    c.id = 'c2-bg';
    Object.assign(c.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      zIndex: '-1',          // behind the p5 canvas
      display: 'block',
      opacity: '0',          // we animate opacity
      pointerEvents: 'none',
      mixBlendMode: 'normal',
    });
    document.body.appendChild(c);
    this.canvas = c;

    // c2 renderer
    const R = new window.c2.Renderer(c);
    this.renderer = R;
    this._sizeToViewport();

    R.background('transparent');
    this.perlin = new window.c2.Perlin();

    // Main draw loop uses c2's scheduler
    R.draw(() => this._frame());

    // resize
    window.addEventListener('resize', this._onResize, { passive: true });
  }

  detach() {
    if (!this.canvas) return;
    window.removeEventListener('resize', this._onResize);
    try { this.renderer && this.renderer.stop && this.renderer.stop(); } catch {}
    try { this.canvas.remove(); } catch {}
    this.canvas = null;
    this.renderer = null;
    this.perlin = null;
    this.alpha = 0;
    this.targetAlpha = 0;
  }

  resize() {
    // exposed so VideoThreshold can forward windowResized
    this._sizeToViewport();
  }

  update() {
    // p5 calls this; c2 drives its own loop. Keep for compatibility.
  }
  draw() {
    // p5 calls this; no drawing needed here.
  }

  /* ---------- internals ---------- */
  _onResize() { this._sizeToViewport(); }

  _sizeToViewport() {
    if (!this.renderer) return;
    const W = Math.floor(window.innerWidth);
    const H = Math.floor(window.innerHeight);
    this.renderer.size(W, H);
    // tweak density based on width so it never overwhelms the foreground
    if (W <= 900) {
      this.row = 18; this.col = 40;
    } else if (W <= 1400) {
      this.row = 20; this.col = 56;
    } else {
      this.row = 22; this.col = 64;
    }
  }

  _frame() {
    const R = this.renderer;
    if (!R || !this.perlin) return;

    const B = _bus();

    // Fade based on playing/rms
    this.targetAlpha = B.playing ? 1 : 0;
    this.alpha += (this.targetAlpha - this.alpha) * this.fadeSlew;
    const show = this.alpha > 0.02;
    this.canvas.style.opacity = String(this.alpha.toFixed(3));
    // If fully hidden, just clear once and early-out to save cycles
    if (!show) {
      R.clear();
      return;
    }

    // Clear every frame (no staining)
    R.clear();

    // Audio→params
    const t = R.frameCount * 0.010;
    const amp = (0.20 + 1.60 * B.rms);                 // vertical amplitude
    const curl = 0.35 + 0.90 * B.bands.treble;         // affects noise sample path
    const bassBend = (B.bands.bass - 0.5) * 0.9;       // warps horizontally
    const lineW = Math.max(1, Math.min(2, 1 + 1.4 * B.rms)); // thin, reacts to volume
    const glow = Math.floor(4 + 32 * (B.rms * 0.6 + B.bands.treble * 0.8)); // glow with volume/treble

    // Shadow/glow
    const ctx = R.ctx;
    ctx.shadowColor = PAL.bright;
    ctx.shadowBlur = glow;

    // Draw stacked noisy strips
    R.lineWidth(lineW);
    for (let i = 0; i < this.row; i++) {
      const trow = window.c2.norm(i, 0, this.row);
      // palette between soft and bright
      const c = window.c2.Color.hsl(210 + 10 * trow, 10 + 10 * trow, 80 + 14 * trow);
      R.stroke(PAL.bright);     // thin stroke to crisp edges
      R.fill(c);

      R.beginPath();
      for (let j = 0; j < this.col; j++) {
        const x = window.c2.map(j, 0, this.col - 1, 0, R.width);
        const baseY = window.c2.map(i, 0, this.row, R.height * 0.35, R.height);

        // 2D noise with a little time swirl + bass bend
        const n = this.perlin.noise(
          (t * curl) + j * 0.10 + bassBend,
          (t * 0.4) + i * 0.045
        ) - 0.5;

        const y = baseY + n * (R.height * amp * 0.12);
        R.lineTo(x, y);
      }
      R.lineTo(R.width, R.height);
      R.lineTo(0, R.height);
      R.endPath(true);
    }

    // reduce shadow blur after drawing to avoid affecting other DOM canvases
    ctx.shadowBlur = 0;
  }
}
