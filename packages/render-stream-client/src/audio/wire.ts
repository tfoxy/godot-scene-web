import { sha256 } from "../sha256";

const utf8 = new TextEncoder();
const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function requireWire(ok: unknown): asserts ok {
  if (!ok) throw new Error("audio-protocol");
}
function uint(value: number, max: number): void {
  requireWire(Number.isInteger(value) && value >= 0 && value <= max);
}
function u64(value: bigint): void {
  requireWire(value >= 0n && value <= 0xffffffffffffffffn);
}
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
}
export function unhex(value: string, size?: number): Uint8Array {
  requireWire(/^(?:[0-9a-f]{2})*$/.test(value));
  requireWire(size === undefined || value.length === size * 2);
  return Uint8Array.from(value.match(/../g) ?? [], (v) =>
    Number.parseInt(v, 16),
  );
}

// Every finite positive float32 is an integer multiple of 2^-150. The extra
// binary place lets us compare its rounding midpoints without fractions.
function binaryUnits(bits: number): bigint {
  const exponent = bits >>> 23;
  const significand = (bits & 0x7fffff) | (exponent ? 0x800000 : 0);
  return BigInt(significand) << BigInt(exponent || 1);
}

/** .NET Single R spelling, with exact shortest-decimal and ties-to-even selection. */
export function floatR(input: number): string {
  const value = Math.fround(input);
  requireWire(Number.isFinite(value));
  if (Object.is(value, -0)) return "-0";
  if (value === 0) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, abs);
  const bits = view.getUint32(0);
  const exact = binaryUnits(bits);
  const lower = exact + binaryUnits(bits - 1);
  // For max float the successor here is the hypothetical finite value 2^128.
  const upper = exact + binaryUnits(bits + 1);
  const inclusive = (bits & 1) === 0;
  const denominator = 1n << 150n;
  // JS only locates the decimal decade; candidate selection uses integers.
  let k = Number(abs.toExponential().split("e")[1]);
  let digits = "";
  for (let n = 1; n <= 9; n++) {
    const power = k - n + 1;
    const scale = 10n ** BigInt(Math.max(-power, 0));
    const divisor = denominator * 10n ** BigInt(Math.max(power, 0));
    const numerator = exact * scale;
    const floor = numerator / divisor;
    let chosen = 0n;
    let distance = divisor;
    // A power-of-two float has a narrower interval below it. Test both
    // neighbours: the nearest decimal can lie outside while the other fits.
    for (const candidate of [floor, floor + 1n]) {
      const midpointUnits = 2n * candidate * divisor;
      if (
        candidate === 0n ||
        midpointUnits < lower * scale ||
        midpointUnits > upper * scale ||
        (!inclusive &&
          (midpointUnits === lower * scale || midpointUnits === upper * scale))
      )
        continue;
      const delta = candidate * divisor - numerator;
      const away = delta < 0n ? -delta : delta;
      if (away < distance || (away === distance && (candidate & 1n) === 0n)) {
        chosen = candidate;
        distance = away;
      }
    }
    if (chosen !== 0n) {
      digits = chosen.toString();
      k += digits.length - n;
      digits = digits.replace(/0+$/, "");
      break;
    }
  }
  requireWire(digits.length > 0);
  if (k >= 9 || k <= -5) {
    return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ""}E${k < 0 ? "-" : "+"}${Math.abs(k).toString().padStart(2, "0")}`;
  }
  const point = k + 1;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length)
    return sign + digits + "0".repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function canonicalKey(
  path: string,
  params: readonly (readonly [string, number])[] = [],
): string {
  // .NET Char.IsWhiteSpace (not JS trim, which also removes U+FEFF).
  requireWire(
    path.length > 0 &&
      // biome-ignore lint/suspicious/noControlCharactersInRegex: .NET whitespace includes control characters.
      /[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(
        path,
      ),
  );
  requireWire(!path.includes("|") && text.decode(utf8.encode(path)) === path);
  const names = new Set<string>();
  for (const [name, value] of params) {
    requireWire(
      /^[\x20-\x7e]+$/.test(name) && !/[=,|]/.test(name) && !names.has(name),
    );
    names.add(name);
    requireWire(Number.isFinite(Math.fround(value)));
  }
  const sorted = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const key =
    path +
    (sorted.length
      ? `|${sorted.map(([name, value]) => `${name}=${floatR(value)}`).join(",")}`
      : "");
  requireWire(utf8.encode(key).length <= 512);
  return key;
}

/** Hash an already canonical key, with schema byte 1. */
export function keyId(key: string): string {
  const bytes = utf8.encode(key);
  requireWire(
    bytes.length > 0 &&
      bytes.length <= 512 &&
      text.decode(utf8.encode(key)) === key,
  );
  const tagged = new Uint8Array(bytes.length + 1);
  tagged[0] = 1;
  tagged.set(bytes, 1);
  return hex(sha256(tagged).subarray(0, 16));
}

export interface BlockHeader {
  kind: number;
  flags: number;
  lane: number;
  codec: number;
  channels: number;
  stream: number;
  block: number;
  rate: number;
  frames: number;
  made_us: bigint;
  due_us: bigint;
  sent_us: bigint;
}
export interface BlockContext {
  lanes?: readonly number[];
  lane_block_frames?: number;
}
export interface Block {
  header: BlockHeader;
  payload: Uint8Array;
}
export function decodeBlock(
  bytes: Uint8Array,
  context: BlockContext = {},
): Block {
  requireWire(bytes.length >= 48);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireWire(v.getUint16(0, true) === 0x4147 && bytes[2] === 1);
  const h: BlockHeader = {
    kind: bytes[3],
    flags: bytes[4],
    lane: bytes[5],
    codec: bytes[6],
    channels: bytes[7],
    stream: v.getUint32(8, true),
    block: v.getUint32(12, true),
    rate: v.getUint32(16, true),
    frames: v.getUint16(20, true),
    made_us: v.getBigUint64(24, true),
    due_us: v.getBigUint64(32, true),
    sent_us: v.getBigUint64(40, true),
  };
  requireWire((h.kind === 1 || h.kind === 2) && (h.flags & ~15) === 0);
  requireWire(
    h.codec === 0 &&
      h.channels === 2 &&
      h.rate === 48000 &&
      v.getUint16(22, true) === 0,
  );
  if (h.kind === 1)
    requireWire(
      h.lane === 0 && h.stream !== 0 && h.frames >= 1 && h.frames <= 2048,
    );
  else
    requireWire(
      h.lane >= 1 &&
        h.lane <= 15 &&
        (context.lanes ?? allLanes).includes(h.lane) &&
        h.frames === (context.lane_block_frames ?? 512),
    );
  requireWire(bytes.length === 48 + (h.flags & 4 ? 0 : h.frames * 4));
  return { header: h, payload: bytes.slice(48) };
}
const allLanes = Array.from({ length: 15 }, (_, i) => i + 1);
export function encodeBlock(
  h: BlockHeader,
  payload: Uint8Array,
  context: BlockContext = {},
): Uint8Array {
  for (const n of [h.kind, h.flags, h.lane, h.codec, h.channels]) uint(n, 255);
  for (const n of [h.stream, h.block, h.rate]) uint(n, 0xffffffff);
  uint(h.frames, 65535);
  for (const n of [h.made_us, h.due_us, h.sent_us]) u64(n);
  const bytes = new Uint8Array(48 + payload.length);
  const v = new DataView(bytes.buffer);
  bytes.set([0x47, 0x41, 1, h.kind, h.flags, h.lane, h.codec, h.channels]);
  v.setUint32(8, h.stream, true);
  v.setUint32(12, h.block, true);
  v.setUint32(16, h.rate, true);
  v.setUint16(20, h.frames, true);
  v.setBigUint64(24, h.made_us, true);
  v.setBigUint64(32, h.due_us, true);
  v.setBigUint64(40, h.sent_us, true);
  bytes.set(payload, 48);
  decodeBlock(bytes, context);
  return bytes;
}

export interface LinkLane {
  id: number;
  name: string;
  group: string;
}
export type LinkMessage =
  | {
      type: 0;
      version: number;
      clock_domain: string;
      bankset: string;
      lanes: LinkLane[];
    }
  | { type: 1; block: string }
  | { type: 2; key_id: string; stream: number; frames: number }
  | { type: 3; key_id: string; stream: number; wav_sha256: string }
  | { type: 4; key_id: string; reason: number }
  | { type: 5; key_id: string; t_us: bigint; key: string }
  | { type: 6; lane_mask: number };
class Writer {
  parts: number[] = [];
  number(n: number | bigint, size: number): void {
    if (typeof n === "number") uint(n, 2 ** (size * 8) - 1);
    else u64(n);
    let bits = BigInt(n);
    for (let i = 0; i < size; i++, bits >>= 8n)
      this.parts.push(Number(bits & 255n));
  }
  bytes(b: Uint8Array): void {
    for (const v of b) this.parts.push(v);
  }
  str(s: string, width: number): void {
    requireWire(text.decode(utf8.encode(s)) === s);
    const b = utf8.encode(s);
    this.number(b.length, width);
    this.bytes(b);
  }
}
class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(n: number): Uint8Array {
    requireWire(this.offset + n <= this.bytes.length);
    const b = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }
  big(n: number): bigint {
    let v = 0n;
    const b = this.take(n);
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }
  number(n: number): number {
    return Number(this.big(n));
  }
  str(width: number): string {
    return text.decode(this.take(this.number(width)));
  }
}
export function encodeLink(m: LinkMessage): Uint8Array {
  const w = new Writer();
  w.number(m.type, 1);
  switch (m.type) {
    case 0:
      w.number(m.version, 2);
      w.bytes(unhex(m.clock_domain, 16));
      w.bytes(unhex(m.bankset, 16));
      w.number(m.lanes.length, 1);
      for (const lane of m.lanes) {
        w.number(lane.id, 1);
        w.str(lane.name, 1);
        w.str(lane.group, 1);
      }
      break;
    case 1:
      w.bytes(unhex(m.block));
      break;
    case 2:
      w.bytes(unhex(m.key_id, 16));
      w.number(m.stream, 4);
      w.number(m.frames, 4);
      break;
    case 3:
      w.bytes(unhex(m.key_id, 16));
      w.number(m.stream, 4);
      w.bytes(unhex(m.wav_sha256, 32));
      break;
    case 4:
      w.bytes(unhex(m.key_id, 16));
      w.number(m.reason, 1);
      break;
    case 5:
      w.bytes(unhex(m.key_id, 16));
      w.number(m.t_us, 8);
      w.str(m.key, 2);
      break;
    case 6:
      w.number(m.lane_mask, 2);
      break;
  }
  const out = Uint8Array.from(w.parts);
  decodeLink(out);
  return out;
}
export function decodeLink(bytes: Uint8Array): LinkMessage {
  const r = new Reader(bytes);
  const type = r.number(1);
  let m: LinkMessage;
  switch (type) {
    case 0: {
      const version = r.number(2);
      requireWire(version === 1);
      const clock_domain = hex(r.take(16));
      const bankset = hex(r.take(16));
      const n = r.number(1);
      requireWire(n <= 15);
      const lanes: LinkLane[] = [];
      const ids = new Set<number>();
      for (let i = 0; i < n; i++) {
        const id = r.number(1);
        requireWire(id >= 1 && id <= 15 && !ids.has(id));
        ids.add(id);
        lanes.push({ id, name: r.str(1), group: r.str(1) });
      }
      m = { type, version, clock_domain, bankset, lanes };
      break;
    }
    case 1: {
      const b = r.take(bytes.length - 1);
      requireWire(decodeBlock(b).header.sent_us === 0n);
      m = { type, block: hex(b) };
      break;
    }
    case 2: {
      const key_id = hex(r.take(16));
      const stream = r.number(4);
      const frames = r.number(4);
      requireWire(stream !== 0 && frames > 0);
      m = { type, key_id, stream, frames };
      break;
    }
    case 3: {
      const key_id = hex(r.take(16));
      const stream = r.number(4);
      requireWire(stream !== 0);
      m = { type, key_id, stream, wav_sha256: hex(r.take(32)) };
      break;
    }
    case 4: {
      const key_id = hex(r.take(16));
      const reason = r.number(1);
      requireWire(reason <= 4);
      m = { type, key_id, reason };
      break;
    }
    case 5: {
      const key_id = hex(r.take(16));
      const t_us = r.big(8);
      const key = r.str(2);
      requireWire(key.length > 0 && utf8.encode(key).length <= 512);
      m = { type, key_id, t_us, key };
      break;
    }
    case 6: {
      const lane_mask = r.number(2);
      requireWire((lane_mask & 1) === 0);
      m = { type, lane_mask };
      break;
    }
    default:
      throw new Error("audio-protocol");
  }
  requireWire(r.offset === bytes.length);
  return m;
}
export type MediaPrefix =
  | { kind: 2; key_id: string }
  | { kind: 3; lane: number };
export function decodePrefix(bytes: Uint8Array): MediaPrefix {
  if (bytes[0] === 2 && bytes.length === 17)
    return { kind: 2, key_id: hex(bytes.subarray(1)) };
  requireWire(
    bytes[0] === 3 && bytes.length === 2 && bytes[1] >= 1 && bytes[1] <= 15,
  );
  return { kind: 3, lane: bytes[1] };
}
export function encodePrefix(p: MediaPrefix): Uint8Array {
  requireWire(p.kind === 2 || p.kind === 3);
  const out =
    p.kind === 2
      ? Uint8Array.of(2, ...unhex(p.key_id, 16))
      : Uint8Array.of(3, p.lane);
  if (p.kind === 3) uint(p.lane, 255);
  decodePrefix(out);
  return out;
}
