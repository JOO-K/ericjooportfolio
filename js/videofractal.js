// videofractal.js — Perlin noise drawing with color shifts
// Audio-reactive noise field with joystick-controlled deformation
// Colors change with video to prevent washing into one blob

import { CONFIG } from './config.js';
import { VideoPlaylist } from './playlist.js';
import { hexToRgb } from './utils.js';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* ----------------- mask helpers ----------------- */
function brightnessAt(maskData, w, h, x, y) {
  if (!maskData) return 255;
  const xi = x | 0, yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 255;
  const i = (yi * w + xi) << 2;
  const a = maskData[i + 3]; if (a < 8) return 255;
  const r = maskData[i], g = maskData[i + 1], b = maskData[i + 2];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function isInside(maskData, w, h, x, y) {
  return brightnessAt(maskData, w, h, x, y) < CONFIG.VIDEO.SIL_BRIGHTNESS_THRESHOLD;
}

/* ----------------- effect ----------------- */
export default class VideoFractalEffect {
  constructor(opts = {}) {
    this.name = 'Video Noise Field';

    this.video = opts.playlist || null;
    this._ownsVideo = !this.video;
    this.maskData = null;
    this.prevMaskHash = 0; // Track when video changes

    // Noise field
    this.noiseScale = 0.006;
    this.noiseTime = 0;
    this.noiseSpeed = 0.4;

    // Drawing state (don't clear each frame)
    this.fadeAmount = 3; // Gentle fade, not full clear

    // Performance - adaptive quality
    this.pixelStep = 5; // Larger step = better performance (was 4)
    this.targetFPS = 60;
    this.frameTimeSamples = [];
    this.maxSamples = 10;

    // Color palette - changes when video changes
    this.currentHue = Math.random() * 360;
    this.targetHue = this.currentHue;

    this.bgRgb = hexToRgb(CONFIG.BG_COLOR);

    // Audio
    this._kEnv = 0; this._prevK = 0;
    this.K_ATTACK = 1.0; this.K_DECAY = 0.88;
    this._flash = 0; this.FLASH_DECAY = 0.85;

    // Joystick
    this._jx = 0; this._jy = 0; this._jmag = 0;

    // Mouse/hover interaction - push pixels effect
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseInfluence = 0; // 0 to 1 based on mouse movement
    this.pixelOffsets = new Map(); // Track pixel displacement {x, y} offsets
    this.pushRadius = 120; // Size of the push effect
    this.pushStrength = 35; // How far pixels get pushed

    // Off-screen graphics for compositing
    this.layer = null;
  }

  onJoystick({ x = 0, y = 0, mag = 0 } = {}) {
    this._jx = clamp(x, -1, 1);
    this._jy = clamp(y, -1, 1);
    this._jmag = clamp(mag, 0, 1);
  }

  preload(p) {}

  setup(p) {
    if (this._ownsVideo) {
      const isMobile = p.windowWidth <= 800;
      this.video = new VideoPlaylist({ isMobile });
      this.video.init(p.width, p.height);
    } else {
      this.video?.resize?.(p.width, p.height);
    }

    this.layer = p.createGraphics(p.width, p.height);
    this.layer.colorMode(p.HSL, 360, 100, 100, 255);

    p.colorMode(p.RGB, 255, 255, 255, 255);
    p.noiseSeed(Date.now());
  }

  dispose() {
    if (this._ownsVideo) this.video?.dispose?.();
    this.layer?.remove?.();
  }

  resize(p) {
    this.video?.resize?.(p.width, p.height);
    this.layer?.remove?.();
    this.layer = p.createGraphics(p.width, p.height);
    this.layer.colorMode(p.HSL, 360, 100, 100, 255);
  }

  _getMaskHash() {
    if (!this.maskData) return 0;
    // Simple hash - sample a few pixels to detect video changes
    let hash = 0;
    const step = 50;
    for (let i = 0; i < this.maskData.length; i += step) {
      hash = ((hash << 5) - hash + this.maskData[i]) | 0;
    }
    return hash;
  }

  _audio() {
    const b = window.__AUDIO_BUS || {};
    const c = (v) => clamp(v ?? 0, 0, 1);
    return {
      playing: !!b.playing,
      rms: c(b.rms),
      k: c(b.kick),
      bass: c(b.bands?.bass),
      mid: c(b.bands?.mid),
      treble: c(b.bands?.treble)
    };
  }

  update(p, dtMs) {
    const dt = Math.min(dtMs || 16.7, 33.3) / 1000;

    // Adaptive performance - adjust quality based on frame time
    this.frameTimeSamples.push(dtMs);
    if (this.frameTimeSamples.length > this.maxSamples) {
      this.frameTimeSamples.shift();
    }

    // Every 30 frames, adjust quality
    if (p.frameCount % 30 === 0 && this.frameTimeSamples.length >= this.maxSamples) {
      const avgFrameTime = this.frameTimeSamples.reduce((a, b) => a + b, 0) / this.frameTimeSamples.length;
      const targetFrameTime = 1000 / this.targetFPS;

      // If running slow, increase step size (lower quality)
      if (avgFrameTime > targetFrameTime * 1.3 && this.pixelStep < 8) {
        this.pixelStep++;
      }
      // If running fast, decrease step size (higher quality)
      else if (avgFrameTime < targetFrameTime * 0.8 && this.pixelStep > 4) {
        this.pixelStep--;
      }
    }

    // Audio envelopes
    const A = this._audio();
    const EDGE = 0.55;
    if (A.k > EDGE && this._prevK <= EDGE) {
      this._kEnv = 1.0;
      this._flash = 1.0;
    }
    this._prevK = A.k;
    this._kEnv = Math.max(this._kEnv * this.K_DECAY, A.k * this.K_ATTACK);
    this._flash *= this.FLASH_DECAY;

    // Update mask
    this.maskData = this.video?.updateMask?.(p.width, p.height) ?? null;

    // Detect video change and shift color
    const currentHash = this._getMaskHash();
    if (this.prevMaskHash !== 0 && currentHash !== 0 && Math.abs(this.prevMaskHash - currentHash) > 1000000) {
      // Video changed significantly - pick new target hue
      this.targetHue = Math.random() * 360;
    }
    this.prevMaskHash = currentHash;

    // Smoothly transition to target hue
    const hueDiff = ((this.targetHue - this.currentHue + 540) % 360) - 180;
    this.currentHue = (this.currentHue + hueDiff * 0.05 + 360) % 360;

    // Mouse interaction - push pixels effect
    const prevMouseX = this.mouseX;
    const prevMouseY = this.mouseY;
    this.mouseX = p.mouseX;
    this.mouseY = p.mouseY;

    // Detect mouse movement and check if over silhouette
    const mouseMoved = Math.abs(this.mouseX - prevMouseX) + Math.abs(this.mouseY - prevMouseY);
    const isOverSilhouette = this.maskData && isInside(this.maskData, p.width, p.height, this.mouseX, this.mouseY);

    if (isOverSilhouette && mouseMoved > 1) {
      this.mouseInfluence = Math.min(1, this.mouseInfluence + 0.2); // Fast response

      // Push pixels away from mouse in a circular area
      const step = this.pixelStep;
      const radiusSq = this.pushRadius * this.pushRadius;

      // Check pixels in a bounding box around the mouse
      const minX = Math.max(0, Math.floor((this.mouseX - this.pushRadius) / step) * step);
      const maxX = Math.min(p.width, Math.ceil((this.mouseX + this.pushRadius) / step) * step);
      const minY = Math.max(0, Math.floor((this.mouseY - this.pushRadius) / step) * step);
      const maxY = Math.min(p.height, Math.ceil((this.mouseY + this.pushRadius) / step) * step);

      for (let y = minY; y < maxY; y += step) {
        for (let x = minX; x < maxX; x += step) {
          if (isInside(this.maskData, p.width, p.height, x, y)) {
            const dx = x - this.mouseX;
            const dy = y - this.mouseY;
            const distSq = dx * dx + dy * dy;

            if (distSq < radiusSq) {
              const dist = Math.sqrt(distSq);
              const normalizedDist = dist / this.pushRadius; // 0 at center, 1 at edge

              // Stronger push at center, fades at edges
              const pushFactor = 1 - Math.pow(normalizedDist, 0.5);

              // Calculate push direction (away from mouse)
              const pushDirX = dist > 0 ? dx / dist : 0;
              const pushDirY = dist > 0 ? dy / dist : 0;

              // Calculate target offset
              const targetOffsetX = pushDirX * this.pushStrength * pushFactor;
              const targetOffsetY = pushDirY * this.pushStrength * pushFactor;

              const key = `${x},${y}`;
              const current = this.pixelOffsets.get(key) || { x: 0, y: 0 };

              // Smoothly move toward target offset
              this.pixelOffsets.set(key, {
                x: lerp(current.x, targetOffsetX, 0.3),
                y: lerp(current.y, targetOffsetY, 0.3)
              });
            }
          }
        }
      }
    } else {
      this.mouseInfluence *= 0.9; // Fast decay
    }

    // Gradually return pixels to their original positions
    for (const [key, offset] of this.pixelOffsets.entries()) {
      const newX = lerp(offset.x, 0, 0.08); // Slow spring back
      const newY = lerp(offset.y, 0, 0.08);

      if (Math.abs(newX) < 0.1 && Math.abs(newY) < 0.1) {
        this.pixelOffsets.delete(key);
      } else {
        this.pixelOffsets.set(key, { x: newX, y: newY });
      }
    }

    // Advance noise time
    this.noiseTime += this.noiseSpeed * dt * (1 + A.mid * 2);
  }

  draw(p) {
    const A = this._audio();

    // Background
    p.background(this.bgRgb.r, this.bgRgb.g, this.bgRgb.b);

    if (!this.maskData) return;

    // Gentle fade on layer (not full clear)
    this.layer.push();
    this.layer.noStroke();
    this.layer.fill(this.bgRgb.r, this.bgRgb.g, this.bgRgb.b, this.fadeAmount);
    this.layer.rect(0, 0, p.width, p.height);
    this.layer.pop();

    // Audio-reactive parameters
    const hueShift = A.treble * 30 + this._kEnv * 20;
    const energy = clamp(A.rms + A.mid * 0.5 + this._kEnv * 0.4, 0, 1);

    // Draw noise field over silhouette
    this.layer.push();
    this.layer.noStroke();

    const step = this.pixelStep; // Use configurable step size

    // Pre-calculate joystick distortion (constant per frame)
    const joyDistortX = this._jx * this._jmag * 100;
    const joyDistortY = this._jy * this._jmag * 100;

    // Pre-calculate common values
    const baseHue = this.currentHue + hueShift;
    const baseSat = 40 + energy * 30;
    const baseLig = 40 + energy * 20;
    const baseAlpha = 12 + energy * 8 + this._flash * 12;
    const noiseTimeBase = this.noiseTime;
    const noiseTimeHalf = noiseTimeBase * 0.5;
    const scaleX = this.noiseScale;
    const scaleY = this.noiseScale;

    for (let y = 0; y < p.height; y += step) {
      for (let x = 0; x < p.width; x += step) {
        if (isInside(this.maskData, p.width, p.height, x, y)) {
          // Check if this pixel has an offset (pushed by mouse)
          const key = `${x},${y}`;
          const offset = this.pixelOffsets.get(key) || { x: 0, y: 0 };

          // Calculate pushed position
          const drawX = x + offset.x;
          const drawY = y + offset.y;

          // Sample noise at ORIGINAL position (not pushed position)
          const noiseVal = p.noise(
            (x + joyDistortX) * scaleX + noiseTimeBase,
            (y + joyDistortY) * scaleY,
            noiseTimeHalf
          );

          // Map noise to color
          const hue = (baseHue + noiseVal * 120) % 360;
          const sat = baseSat + noiseVal * 30;
          const lig = baseLig + noiseVal * 20;
          const alpha = Math.round(baseAlpha);

          // Draw at pushed position
          this.layer.fill(hue, sat, lig, alpha);
          this.layer.rect(drawX, drawY, step, step);
        }
      }
    }
    this.layer.pop();

    // Composite layer
    p.image(this.layer, 0, 0);
  }
}
