// Draws the Hassle Free TV artwork (cartoon TV with a star) and writes all PNGs — no image libraries needed.
// Run from the repo root:  node tools/make-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const TOP = hex('#3a2a8f'), BOT = hex('#1b1446'), YEL = hex('#ffcc33'), PUR = hex('#1b1446'), WHITE = hex('#ffffff');

/* ---------- shapes ---------- */
const rrect = (x, y, cx, cy, hw, hh, r) => {
  const dx = Math.max(Math.abs(x - cx) - (hw - r), 0), dy = Math.max(Math.abs(y - cy) - (hh - r), 0);
  return dx * dx + dy * dy <= r * r;
};
const seg = (x, y, x1, y1, x2, y2, w) => {            // thick line with round caps
  const vx = x2 - x1, vy = y2 - y1, t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / (vx * vx + vy * vy || 1)));
  const ex = x - (x1 + t * vx), ey = y - (y1 + t * vy);
  return ex * ex + ey * ey <= w * w;
};
const STAR = Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? 0.055 : 0.13;
  return [0.5 + rad * Math.cos(a), 0.56 + rad * Math.sin(a)];
});
const inPoly = (x, y, P) => {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const bg = y => TOP.map((c, i) => c + (BOT[i] - c) * y);

/** The icon, in a unit square. Returns a colour or null (transparent → background). */
function tv(x, y) {
  if (seg(x, y, 0.5, 0.33, 0.39, 0.2, 0.018) || seg(x, y, 0.5, 0.33, 0.61, 0.2, 0.018)) return YEL;     // antennas
  if (rrect(x, y, 0.39, 0.2, 0.03, 0.03, 0.03) || rrect(x, y, 0.61, 0.2, 0.03, 0.03, 0.03)) return YEL;  // antenna tips
  if (rrect(x, y, 0.5, 0.56, 0.3, 0.23, 0.07)) {                                                         // TV body
    if (rrect(x, y, 0.5, 0.56, 0.235, 0.17, 0.04)) return inPoly(x, y, STAR) ? YEL : PUR;               // screen + star
    return YEL;
  }
  return null;
}

/* ---------- a tiny rounded stroke font for the TV banner ---------- */
const GLYPHS = {
  K: [[0, 0, 0, 1], [0.95, 0, 0.05, 0.55], [0.32, 0.38, 1, 1]],
  I: [[0.5, 0, 0.5, 1], [0.15, 0, 0.85, 0], [0.15, 1, 0.85, 1]],
  D: [[0, 0, 0, 1], [0, 0, 0.55, 0], [0.55, 0, 1, 0.3], [1, 0.3, 1, 0.7], [1, 0.7, 0.55, 1], [0.55, 1, 0, 1]],
  S: [[1, 0, 0, 0], [0, 0, 0, 0.5], [0, 0.5, 1, 0.5], [1, 0.5, 1, 1], [1, 1, 0, 1]],
  T: [[0, 0, 1, 0], [0.5, 0, 0.5, 1]],
  U: [[0, 0, 0, 1], [0, 1, 1, 1], [1, 1, 1, 0]],
  B: [[0, 0, 0, 1], [0, 0, 0.8, 0], [0.8, 0, 0.8, 0.5], [0, 0.5, 1, 0.5], [1, 0.5, 1, 1], [1, 1, 0, 1]],
  E: [[0, 0, 0, 1], [0, 0, 1, 0], [0, 0.5, 0.8, 0.5], [0, 1, 1, 1]],
  H: [[0, 0, 0, 1], [1, 0, 1, 1], [0, 0.5, 1, 0.5]],
  A: [[0, 1, 0.5, 0], [0.5, 0, 1, 1], [0.22, 0.6, 0.78, 0.6]],
  L: [[0, 0, 0, 1], [0, 1, 1, 1]],
  F: [[0, 0, 0, 1], [0, 0, 1, 0], [0, 0.5, 0.8, 0.5]],
  R: [[0, 0, 0, 1], [0, 0, 0.85, 0], [0.85, 0, 0.85, 0.5], [0, 0.5, 0.85, 0.5], [0.35, 0.5, 1, 1]],
  V: [[0, 0, 0.5, 1], [0.5, 1, 1, 0]],
  ' ': []
};
function text(x, y, str, x0, y0, w, h, gap, stroke) {
  for (let i = 0; i < str.length; i++) {
    const gx = x0 + i * (w + gap);
    if (x < gx - stroke || x > gx + w + stroke || y < y0 - stroke || y > y0 + h + stroke) continue;
    for (const [a, b, c, d] of GLYPHS[str[i]]) {
      if (seg(x, y, gx + a * w, y0 + b * h, gx + c * w, y0 + d * h, stroke)) return true;
    }
  }
  return false;
}

/* ---------- renderers (pixel coords → colour) ---------- */
const iconPx = (W, H) => (px, py) => tv(px / W, py / H) || bg(py / H);
const bannerPx = (W, H) => (px, py) => {
  const s = Math.min(W / 320, H / 180);                      // design at 320×180, centred for other shapes
  const x = (px - (W - 320 * s) / 2) / s, y = (py - (H - 180 * s) / 2) / s;
  const ix = (x - 4) / 142, iy = (y - 19) / 142;             // icon on the left
  if (ix >= 0 && ix <= 1 && iy >= 0 && iy <= 1) { const c = tv(ix, iy); if (c) return c; }
  if (text(x, y, 'HASSLE', 152, 46, 15.5, 38, 6, 3.8)) return WHITE;
  if (text(x, y, 'FREE TV', 152, 100, 15.5, 38, 6, 3.8)) return YEL;
  return bg(py / H);
};

/* ---------- PNG encoder ---------- */
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(W, H, colorAt) {
  const SS = 4, row = W * 3 + 1, raw = Buffer.alloc(H * row);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = colorAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      for (let i = 0; i < 3; i++) raw[y * row + 1 + x * 3 + i] = Math.round(acc[i] / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function write(file, W, H, renderer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png(W, H, renderer(W, H)));
  console.log('wrote', file);
}

/* ---------- outputs ---------- */
const WEB = 'public/icons', RES = 'tv-android/app/src/main/res';
for (const [name, n] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180], ['favicon-32.png', 32]]) {
  write(path.join(WEB, name), n, n, iconPx);
}
for (const [dpi, n] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
  write(path.join(RES, `mipmap-${dpi}`, 'ic_launcher.png'), n, n, iconPx);
}
write(path.join(RES, 'drawable-xhdpi', 'banner.png'), 320, 180, bannerPx);
write(path.join(RES, 'drawable-xxhdpi', 'banner.png'), 640, 360, bannerPx);
// Google Play store graphics
write('store/graphics/icon-512.png', 512, 512, iconPx);
write('store/graphics/feature-graphic-1024x500.png', 1024, 500, bannerPx);
write('store/graphics/tv-banner-1280x720.png', 1280, 720, bannerPx);
// Amazon Appstore (Fire TV): small icon, and a text-free background shown behind the app details
const backgroundPx = (W, H) => (px, py) => {
  const b = bg(py / H), s = H * 0.8, ix = (px - (W - s - H * 0.08)) / s, iy = (py - (H - s) / 2) / s;
  if (ix >= 0 && ix <= 1 && iy >= 0 && iy <= 1) { const c = tv(ix, iy); if (c) return c === PUR ? b.map(v => v * 0.85) : b.map(v => v + (255 - v) * 0.12); }
  return b;
};
write('store/amazon/icon-114.png', 114, 114, iconPx);
write('store/amazon/icon-512.png', 512, 512, iconPx);
write('store/amazon/firetv-icon-1280x720.png', 1280, 720, bannerPx);
write('store/amazon/background-1920x1080.png', 1920, 1080, backgroundPx);
