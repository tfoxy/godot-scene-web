// A raw-socket render-stream-track/1 client: an upgrade
// offering any subprotocols, masked text/close frames, ping answers, and a socket that can be
// destroyed mid-track or sent arbitrary frames, which Node's WebSocket cannot do. Shared by
// scripts/test/self-test-tracks.ts (TRK1) and scripts/lib/track-input-client.ts (TRK2, gate 8's
// g8l/trk legs).
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

export const TRACK_SUBPROTOCOL = "render-stream-track.1";

export interface Closed {
  code: number;
  reason: string;
}

export class RawTrack {
  texts: string[] = [];
  closed: Closed | null = null;
  ended = false;
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private keepalive: NodeJS.Timeout | null = null;
  constructor(readonly socket: Socket) {
    socket.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.parse();
    });
    socket.on("close", () => {
      this.ended = true;
      this.stopKeepalive();
      this.wake();
    });
    socket.on("error", () => {});
  }

  /** Opens `/render-stream` offering `protocols`; resolves with the status line and the client. */
  static open(
    port: number,
    protocols: string,
  ): Promise<{ status: string; head: string; track: RawTrack }> {
    return new Promise((res, rej) => {
      const socket = connect(port, "127.0.0.1");
      let head = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        head = Buffer.concat([head, d]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        const text = head.subarray(0, end + 4).toString("latin1");
        const track = new RawTrack(socket);
        const rest = head.subarray(end + 4);
        if (rest.length > 0) socket.emit("data", rest);
        res({ status: text.split("\r\n")[0], head: text, track });
      };
      socket.on("data", onData);
      socket.on("error", rej);
      socket.on("connect", () => {
        socket.write(
          "GET /render-stream HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n" +
            "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            `Sec-WebSocket-Protocol: ${protocols}\r\n\r\n`,
        );
      });
    });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private parse(): void {
    while (this.buf.length >= 2) {
      const op = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (op === 1) this.texts.push(payload.toString("utf8"));
      else if (op === 8) {
        this.closed = {
          code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
          reason: payload.subarray(2).toString("utf8"),
        };
      } else if (op === 9) this.frame(10, payload);
      this.wake();
    }
  }

  frame(op: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const mask = randomBytes(4);
    const n = payload.length;
    const head =
      n < 126
        ? Buffer.from([0x80 | op, 0x80 | n])
        : n < 65536
          ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 0xff])
          : (() => {
              const b = Buffer.alloc(10);
              b[0] = 0x80 | op;
              b[1] = 0x80 | 127;
              b.writeBigUInt64BE(BigInt(n), 2);
              return b;
            })();
    const body = Buffer.alloc(n);
    for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([head, mask, body]));
  }

  send(text: string): void {
    this.frame(1, Buffer.from(text, "utf8"));
  }

  /** Sends "" every `ms` (the client's keepalive, T10). */
  startKeepalive(ms: number): void {
    this.keepalive = setInterval(() => this.send(""), ms);
  }
  stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  close(code = 1000): void {
    this.stopKeepalive();
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this.frame(8, p);
  }

  destroy(): void {
    this.stopKeepalive();
    this.socket.destroy();
  }

  /** Waits until `pred` holds or `ms` pass. */
  async until(pred: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      const left = deadline - Date.now();
      if (left <= 0 || this.ended) return pred();
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
    return true;
  }

  controls(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const t of this.texts) {
      if (t === "") continue;
      try {
        const v = JSON.parse(t) as Record<string, unknown>;
        if (v.type === "track-ready" || v.type === "track-error") out.push(v);
      } catch {
        // a down payload
      }
    }
    return out;
  }
}
