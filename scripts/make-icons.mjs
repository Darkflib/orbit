// ---------------------------------------------------------------------------
// Render the Orbit mark to the PNG icons the manifest and iOS need.
//
//   node scripts/make-icons.mjs
//
// The favicon in index.html is an inline SVG data URI, which browsers are happy
// with but installers are not: Android wants raster icons at known sizes, and
// iOS ignores anything that is not an <link rel="apple-touch-icon"> PNG. Rather
// than commit four binaries with no way to regenerate them, the mark is defined
// once here as geometry and rasterised. Rerun after changing it and commit the
// output; test/pwa.test.mjs checks the committed PNGs are the ones this
// script produces.
//
// Everything is hand-rolled — supersampled coverage for the shapes, zlib for
// the PNG — because the project has no image dependency and this is not worth
// acquiring one for.
// ---------------------------------------------------------------------------
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const ICON_DIR = join(REPO_ROOT, 'icons');

// The mark, in a 100x100 design space — the same geometry as the inline SVG
// favicon in index.html, so the tab icon and the installed icon match.
const BG = [11, 18, 32];        // #0b1220 page background
const GLOBE = [19, 34, 52];     // #132234 slightly lifted, so the disc reads
const ACCENT = [56, 189, 248];  // #38bdf8 the app's accent
const DOT = [250, 204, 21];     // #facc15 the satellite

const GLOBE_R = 30;
const GLOBE_STROKE = 4;
const ORBIT_RX = 46;
const ORBIT_RY = 18;
const ORBIT_STROKE = 3;
const ORBIT_TILT = -30 * (Math.PI / 180);
const SAT = { x: 87, y: 34, r: 6 };

// Icons Android may crop to an arbitrary shape must keep their content inside
// the inner 80% circle; anything outside can be shaved off. The whole mark is
// scaled into that safe zone rather than trusting the corners to survive.
const MASKABLE_SCALE = 0.62;

const SIZES = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
];

// Samples per pixel per axis. 4 is plenty at these sizes and keeps the whole
// run well under a second.
const SS = 4;

function mix(dst, src, alpha) {
  for (let i = 0; i < 3; i++) dst[i] = dst[i] * (1 - alpha) + src[i] * alpha;
}

// Signed distance to the orbit ellipse's outline, in design units.
//
// There is no closed form for the distance from a point to an ellipse, but the
// first-order estimate f / |grad f| is accurate to well under a pixel this far
// from the degenerate centre, which is all a 3-unit stroke needs.
function ellipseEdgeDistance(x, y) {
  const dx = x - 50;
  const dy = y - 50;
  // Undo the tilt, so the ellipse is axis-aligned in this frame.
  const c = Math.cos(-ORBIT_TILT);
  const s = Math.sin(-ORBIT_TILT);
  const px = dx * c - dy * s;
  const py = dx * s + dy * c;
  const f = (px * px) / (ORBIT_RX * ORBIT_RX) + (py * py) / (ORBIT_RY * ORBIT_RY) - 1;
  const gx = (2 * px) / (ORBIT_RX * ORBIT_RX);
  const gy = (2 * py) / (ORBIT_RY * ORBIT_RY);
  const grad = Math.hypot(gx, gy);
  return grad === 0 ? Infinity : f / grad;
}

// Colour of one sample point in design space, painted back to front: the orbit
// passes *behind* the globe, which is what makes it read as an orbit rather
// than a ring drawn across a disc.
function sampleColour(x, y) {
  const px = [...BG];

  if (Math.abs(ellipseEdgeDistance(x, y)) <= ORBIT_STROKE / 2) mix(px, ACCENT, 1);

  const rc = Math.hypot(x - 50, y - 50);
  if (rc <= GLOBE_R + GLOBE_STROKE / 2) {
    mix(px, rc >= GLOBE_R - GLOBE_STROKE / 2 ? ACCENT : GLOBE, 1);
  }

  if (Math.hypot(x - SAT.x, y - SAT.y) <= SAT.r) mix(px, DOT, 1);

  return px;
}

export function renderIcon(size, maskable) {
  const rgb = Buffer.alloc(size * size * 3);
  // Design-space transform: the mark occupies the full tile, or the maskable
  // safe zone, centred either way.
  const scale = (maskable ? MASKABLE_SCALE : 1) * (size / 100);
  const offset = (size - 100 * scale) / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = (px + (sx + 0.5) / SS - offset) / scale;
          const dy = (py + (sy + 0.5) / SS - offset) / scale;
          const c = sampleColour(dx, dy);
          acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 3;
      rgb[i] = Math.round(acc[0] / n);
      rgb[i + 1] = Math.round(acc[1] / n);
      rgb[i + 2] = Math.round(acc[2] / n);
    }
  }
  return encodePng(size, size, rgb);
}

// --- minimal PNG writer (8-bit truecolour, no alpha) ------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  // 10..12: deflate, adaptive filtering, no interlace — all zero.

  // Filter byte 0 (None) per scanline. The art is smooth gradients over flat
  // fields, which deflate handles well enough that per-line filter selection
  // would buy very little for a good deal more code.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

export async function readIconDigests() {
  const out = {};
  for (const { file } of SIZES) {
    out[file] = createHash('sha256')
      .update(await readFile(join(ICON_DIR, file)))
      .digest('hex');
  }
  return out;
}

export { SIZES };

// pathToFileURL rather than a `file://` template, which is wrong for paths with
// spaces or non-ASCII characters and for Windows drive letters.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mkdir(ICON_DIR, { recursive: true });
  for (const { file, size, maskable } of SIZES) {
    const png = renderIcon(size, maskable);
    await writeFile(join(ICON_DIR, file), png);
    console.log(`  ${file}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} KiB`);
  }
}
