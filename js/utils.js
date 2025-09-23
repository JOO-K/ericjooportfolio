export function hexToRgb(hex) {
  let h = hex.replace('#','').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function hashCell(x, y) {
  // deterministic 2D hash
  const s = Math.sin((x + 13.37) * (y + 7.77));
  return Math.abs(s * 43758.5453) % 1;
}

export function drawImageCover(p, img, x, y, w, h, alpha = 255) {
  if (!img) return;
  const iw = img.width, ih = img.height; if (!iw || !ih) return;
  const rBox = w / h, rImg = iw / ih;
  let dw, dh; if (rImg > rBox) { dh = h; dw = rImg * dh; } else { dw = w; dh = dw / rImg; }
  p.push(); p.tint(255, alpha);
  p.image(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  p.pop();
}
