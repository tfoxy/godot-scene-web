// @vitest-environment node

import {
  DirectPeerError,
  type DirectPeerOptions,
  openDirectPeer,
} from "@godot-scene-web/direct-peer";
import { afterEach, describe, expect, it, vi } from "vitest";

const offer = {
  type: "offer" as const,
  sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\n",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  binaryType = "blob";
  constructor(
    readonly label: string,
    readonly init?: RTCDataChannelInit,
  ) {
    super();
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}
class FakeConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  channels: FakeChannel[] = [];
  remote = deferred<RTCSessionDescriptionInit>();
  local = deferred<RTCSessionDescriptionInit>();
  offered = deferred<void>();
  offerGate: Promise<RTCSessionDescriptionInit> = Promise.resolve(offer);
  remoteError?: Error;
  channelError?: Error;
  immediateChannelState?: RTCDataChannelState;
  createOffer = vi.fn(() => {
    this.offered.resolve();
    return this.offerGate;
  });
  setLocalDescription = vi.fn(async (value: RTCSessionDescriptionInit) => {
    this.local.resolve(value);
  });
  setRemoteDescription = vi.fn(async (value: RTCSessionDescriptionInit) => {
    this.remote.resolve(value);
    if (this.remoteError) throw this.remoteError;
  });
  createDataChannel = vi.fn((label: string, init?: RTCDataChannelInit) => {
    if (this.channelError) throw this.channelError;
    const channel = new FakeChannel(label, init);
    if (this.immediateChannelState)
      channel.readyState = this.immediateChannelState;
    this.channels.push(channel);
    return channel;
  });
  state(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  // Native close() changes state without dispatching connectionstatechange.
  nativeClose = vi.fn(() => {
    this.connectionState = "closed";
  });
  close = this.nativeClose;
}
const peers: FakeConnection[] = [];
function setup(extra: Partial<DirectPeerOptions> = {}) {
  const pc = new FakeConnection();
  peers.push(pc);
  const Constructor = vi.fn(function FakePeerConnection() {
    return pc;
  });
  const options: DirectPeerOptions = {
    host: "192.0.2.1",
    port: 45000,
    fingerprint: Uint8Array.from({ length: 32 }, (_, i) => i),
    RTCPeerConnection: Constructor as unknown as typeof RTCPeerConnection,
    ...extra,
  };
  return { pc, options, Constructor };
}
async function connect() {
  const context = setup();
  const promise = openDirectPeer(context.options);
  await context.pc.remote.promise;
  context.pc.state("connected");
  return { ...context, peer: await promise };
}
afterEach(() => {
  for (const pc of peers.splice(0)) pc.state("closed");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("direct peer establishment", () => {
  it("uses the injected constructor, disables ICE servers and leaves the local offer unmodified", async () => {
    const { pc, options, Constructor } = setup({
      rtcConfiguration: {
        iceServers: [{ urls: "stun:example.com" }],
        bundlePolicy: "max-bundle",
      },
    });
    const promise = openDirectPeer(options);
    const answer = await pc.remote.promise;
    expect(Constructor).toHaveBeenCalledWith({
      iceServers: [],
      bundlePolicy: "max-bundle",
    });
    expect(pc.setLocalDescription).toHaveBeenCalledWith(offer);
    expect(answer).toMatchObject({
      type: "answer",
      sdp: expect.stringContaining("a=mid:data\r\n"),
    });
    expect(pc.channels[0].binaryType).toBe("arraybuffer");
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    pc.channels[0].open();
    await Promise.resolve();
    expect(resolved).toBe(false);
    pc.state("connected");
    const peer = await promise;
    expect(peer.connection).toBe(pc);
    peer.close();
    await peer.closed;
  });
  it("uses the global constructor and accepts a textual fingerprint", async () => {
    const { pc, options, Constructor } = setup();
    delete options.RTCPeerConnection;
    options.fingerprint = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    vi.stubGlobal("RTCPeerConnection", Constructor);
    const promise = openDirectPeer(options);
    await pc.remote.promise;
    pc.state("connected");
    (await promise).close();
  });
  it("rejects a missing constructor with a typed error", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    const { options } = setup();
    delete options.RTCPeerConnection;
    await expect(openDirectPeer(options)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
  it("wraps constructor errors", async () => {
    const { options } = setup();
    options.RTCPeerConnection = function BrokenPeerConnection() {
      throw Error("constructor failed");
    } as unknown as typeof RTCPeerConnection;
    await expect(openDirectPeer(options)).rejects.toMatchObject({
      code: "negotiation-failed",
      cause: Error("constructor failed"),
    });
  });
  it("times out, closes once, and ignores late negotiation completion", async () => {
    const { pc, options } = setup();
    const gate = deferred<RTCSessionDescriptionInit>();
    pc.offerGate = gate.promise;
    vi.useFakeTimers();
    const promise = openDirectPeer({ ...options, timeoutMs: 30 });
    const rejected = expect(promise).rejects.toMatchObject({ code: "timeout" });
    await pc.offered.promise;
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    gate.resolve(offer);
    await Promise.resolve();
    expect(pc.setLocalDescription).not.toHaveBeenCalled();
    expect(pc.nativeClose).toHaveBeenCalledTimes(1);
  });
  it("aborts before allocation", async () => {
    const controller = new AbortController();
    controller.abort();
    const { options, Constructor } = setup({ signal: controller.signal });
    await expect(openDirectPeer(options)).rejects.toMatchObject({
      code: "aborted",
    });
    expect(Constructor).not.toHaveBeenCalled();
  });
  it("aborts during negotiation and closes", async () => {
    const controller = new AbortController();
    const { pc, options } = setup({ signal: controller.signal });
    const promise = openDirectPeer(options);
    const rejected = expect(promise).rejects.toMatchObject({ code: "aborted" });
    await pc.remote.promise;
    controller.abort();
    await rejected;
    expect(pc.nativeClose).toHaveBeenCalledTimes(1);
  });
  it.each([
    "failed",
    "closed",
  ] as const)("rejects when the peer becomes %s before connection", async (state) => {
    const { pc, options } = setup();
    const promise = openDirectPeer(options);
    const rejected = expect(promise).rejects.toMatchObject({
      code: state === "failed" ? "connection-failed" : "closed",
    });
    await pc.remote.promise;
    pc.state(state);
    await rejected;
    expect(pc.nativeClose).toHaveBeenCalledTimes(1);
  });
  it("wraps negotiation exceptions and closes", async () => {
    const { pc, options } = setup();
    pc.remoteError = Error("answer rejected");
    await expect(openDirectPeer(options)).rejects.toMatchObject({
      code: "negotiation-failed",
      cause: pc.remoteError,
    });
    expect(pc.nativeClose).toHaveBeenCalledTimes(1);
  });
  it("preserves typed fingerprint errors and closes", async () => {
    const { pc, options } = setup({ fingerprint: "bad" });
    await expect(openDirectPeer(options)).rejects.toBeInstanceOf(
      DirectPeerError,
    );
    expect(pc.nativeClose).toHaveBeenCalledTimes(1);
  });
  it("detaches the establishment deadline and abort signal after connecting", async () => {
    const controller = new AbortController();
    vi.useFakeTimers();
    const { pc, options } = setup({ signal: controller.signal });
    const promise = openDirectPeer(options);
    await pc.remote.promise;
    pc.state("connected");
    const peer = await promise;
    controller.abort();
    await vi.advanceTimersByTimeAsync(20000);
    expect(pc.nativeClose).not.toHaveBeenCalled();
    peer.close();
  });
});

describe("direct peer lifetime and channels", () => {
  it("settles closure and rejects channels when the exposed connection closes without an event", async () => {
    const { pc, peer } = await connect();
    const closed = vi.fn();
    void peer.closed.then(closed);
    const pending = peer
      .openChannel("pending")
      .catch((error: unknown) => error);
    const created = pc.createDataChannel.mock.calls.length;
    peer.connection.close();
    await Promise.resolve();
    expect(pc.connectionState).toBe("closed");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(await pending).toMatchObject({ code: "closed" });
    await expect(peer.openChannel("too late")).rejects.toMatchObject({
      code: "closed",
    });
    expect(pc.createDataChannel).toHaveBeenCalledTimes(created);
    peer.connection.close();
    peer.close();
    expect(pc.nativeClose).toHaveBeenCalledTimes(1);
  });
  it("opens channels with the supplied label/init and ArrayBuffer messages", async () => {
    const { pc, peer } = await connect();
    const init = { ordered: false, maxRetransmits: 0 };
    const promise = peer.openChannel("payload", init);
    const channel = pc.channels[1];
    expect(pc.createDataChannel).toHaveBeenLastCalledWith("payload", init);
    expect(channel.binaryType).toBe("arraybuffer");
    channel.open();
    expect(await promise).toBe(channel);
    peer.close();
  });
  it.each([
    "error",
    "close",
  ])("rejects a channel %s before open", async (event) => {
    const { pc, peer } = await connect();
    const promise = peer.openChannel("payload");
    const rejected = expect(promise).rejects.toMatchObject({
      code: "channel-failed",
    });
    pc.channels[1].dispatchEvent(new Event(event));
    await rejected;
    peer.close();
  });
  it("wraps a createDataChannel exception", async () => {
    const { pc, peer } = await connect();
    pc.channelError = Error("channel limit");
    await expect(peer.openChannel("payload")).rejects.toMatchObject({
      code: "channel-failed",
      cause: pc.channelError,
    });
    peer.close();
  });
  it.each([
    "open",
    "closed",
    "closing",
  ] as const)("handles an immediately %s channel", async (state) => {
    const { pc, peer } = await connect();
    pc.immediateChannelState = state;
    const promise = peer.openChannel("payload");
    if (state === "open") expect(await promise).toBe(pc.channels[1]);
    else
      await expect(promise).rejects.toMatchObject({ code: "channel-failed" });
    peer.close();
  });
  it.each([
    "failed",
    "closed",
    "explicit",
  ] as const)("settles closed and all pending channels on %s", async (state) => {
    const { pc, peer } = await connect();
    const a = peer.openChannel("a"),
      b = peer.openChannel("b");
    const code = state === "failed" ? "connection-failed" : "closed";
    const rejectedA = expect(a).rejects.toMatchObject({ code });
    const rejectedB = expect(b).rejects.toMatchObject({ code });
    if (state === "explicit") peer.close();
    else pc.state(state);
    await Promise.all([peer.closed, rejectedA, rejectedB]);
    await expect(peer.openChannel("too late")).rejects.toMatchObject({ code });
    peer.close();
    peer.close();
    expect(pc.nativeClose).toHaveBeenCalledTimes(1);
  });
  it("allows disconnected to recover without treating it as closed", async () => {
    const { pc, peer } = await connect();
    pc.state("disconnected");
    pc.state("connected");
    expect(pc.nativeClose).not.toHaveBeenCalled();
    peer.close();
    await peer.closed;
  });
});
