import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * Generate the small synthetic textures used by the image-diff parity fixtures:
 * the SQUARES the texture-regression fixture needs (squares image-diff cleanly
 * between Godot and the browser) and the soft radial DOT the particle-blend
 * fixture needs. The textures are tiny + self-authored, so the PNGs are
 * committed directly and this script exists only to document/reproduce exactly
 * how they were made.
 *
 * Run with: `mise exec -- tsx scripts/generate-fixture-textures.ts`
 *
 * Uses a hand-rolled PNG encoder (zlib only) so it has no third-party deps and
 * runs from the repo root regardless of the pnpm workspace layout.
 */

type Rgba = [number, number, number, number];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encode an RGBA8 pixel buffer (row-major, width*height*4 bytes) to PNG. */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type: RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace
  // Prefix each scanline with filter byte 0 (none).
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeBuffer(
  width: number,
  height: number,
  paint: (x: number, y: number) => Rgba,
): Buffer {
  const buffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const offset = (y * width + x) * 4;
      buffer[offset] = r;
      buffer[offset + 1] = g;
      buffer[offset + 2] = b;
      buffer[offset + 3] = a;
    }
  }
  return buffer;
}

// np64.png — 64x64 opaque: a 1px red border with a blue center, so nine-patch
// slicing is visually verifiable (corners carry the border, the center tiles
// blue).
const BORDER: Rgba = [212, 64, 52, 255];
const CENTER: Rgba = [64, 132, 204, 255];
const np64 = makeBuffer(64, 64, (x, y) => {
  const onBorder = x === 0 || y === 0 || x === 63 || y === 63;
  return onBorder ? BORDER : CENTER;
});

// atlas128.png — 128x128 transparent with a recognizable opaque 64x64 square at
// offset (32,32): a green block with a darker top-left quadrant so orientation
// (and the atlas sub-region crop) is verifiable. Everything outside is clear.
const TRANSPARENT: Rgba = [0, 0, 0, 0];
const SQUARE: Rgba = [90, 184, 112, 255];
const QUADRANT: Rgba = [34, 92, 58, 255];
const atlas128 = makeBuffer(128, 128, (x, y) => {
  const inRegion = x >= 32 && x < 96 && y >= 32 && y < 96;
  if (!inRegion) {
    return TRANSPARENT;
  }
  const inQuadrant = x < 64 && y < 64;
  return inQuadrant ? QUADRANT : SQUARE;
});

// softdot32.png — 32x32 particle sprite for the ADD/MIX blend parity fixture
// (fixtures/visual-2d/particles-blend.tscn).
//
// WHY A TEXTURE AT ALL. An untextured GPUParticles2D cannot be compared across
// the two renderers even in principle: Godot draws a 1x1 white quad scaled to
// the particle, the browser draws a PROCEDURAL soft dot
// (particles/render-webgl.ts). The two disagree on the picture before any blend
// algebra is involved, so a blend fixture has to supply its own sprite and take
// the procedural path out of the comparison.
//
// WHY THIS SHAPE. Alpha is a linear radial ramp — solid to radius 8, falling to
// zero at radius 16 — so one sprite exercises the full alpha range in a single
// frame: a saturated core where N-deep accumulation is unambiguous, and a wide
// soft skirt where a wrong blend factor (a vs a^2 on the destination, say)
// shows up as a visible ring rather than a rounding difference.
//
// WHY WHITE EVERYWHERE. RGB is 255 even under fully transparent pixels. Godot's
// image importer runs `fix_alpha_border` by DEFAULT, rewriting the RGB of
// transparent texels from their neighbours to kill filtering fringes; with a
// uniform white RGB that pass is a no-op, so the imported texture is
// byte-identical to the PNG the browser decodes. A black transparent rim would
// have made the two sides differ for import reasons alone.
const SOFT_DOT_SIZE = 32;
const SOFT_DOT_RADIUS = SOFT_DOT_SIZE / 2;
/** Normalized radius at which alpha starts falling: 8px / 16px. */
const SOFT_DOT_CORE = 0.5;
const softdot32 = makeBuffer(SOFT_DOT_SIZE, SOFT_DOT_SIZE, (x, y) => {
  // Pixel CENTRES against the texture centre, so the dot is symmetric about the
  // 16,16 corner rather than biased half a texel up-left.
  const dx = x + 0.5 - SOFT_DOT_RADIUS;
  const dy = y + 0.5 - SOFT_DOT_RADIUS;
  const r = Math.sqrt(dx * dx + dy * dy) / SOFT_DOT_RADIUS;
  const alpha = Math.min(1, Math.max(0, (1 - r) / (1 - SOFT_DOT_CORE)));
  return [255, 255, 255, Math.round(alpha * 255)];
});

writeFileSync(join("fixtures", "images", "np64.png"), encodePng(64, 64, np64));
writeFileSync(
  join("fixtures", "images", "atlas128.png"),
  encodePng(128, 128, atlas128),
);
writeFileSync(
  join("fixtures", "assets", "softdot32.png"),
  encodePng(SOFT_DOT_SIZE, SOFT_DOT_SIZE, softdot32),
);
process.stdout.write(
  "wrote fixtures/images/np64.png, fixtures/images/atlas128.png and fixtures/assets/softdot32.png\n",
);
