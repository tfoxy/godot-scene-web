export * from "./helpers";

import {
  buildLiteAnswer,
  DirectPeerError,
  deriveIceCredentials,
  parseFingerprint,
} from "./helpers";

export interface DirectPeerOptions {
  /** IP literal of an ICE-lite host. */
  host: string;
  port: number;
  fingerprint: Uint8Array | string;
  /** Additional configuration. ICE servers are always disabled. */
  rtcConfiguration?: RTCConfiguration;
  /** Establishment deadline, including credential derivation and SDP operations. Default: 15000 ms. */
  timeoutMs?: number;
  /** Cancels establishment only; detached once connected. */
  signal?: AbortSignal;
  RTCPeerConnection?: typeof RTCPeerConnection;
}

export interface DirectPeer {
  readonly connection: RTCPeerConnection;
  /** Resolves on failure or closure, including close() on this peer or its exposed connection. */
  readonly closed: Promise<void>;
  /** Resolves on open with binaryType=arraybuffer; rejects on channel error/close or peer termination. */
  openChannel(
    label: string,
    init?: RTCDataChannelInit,
  ): Promise<RTCDataChannel>;
  close(): void;
}

/**
 * Connect directly to an ICE-lite host using an unmodified local offer and a fabricated answer.
 * Resolves at connectionState="connected". The negotiation channel remains owned by the connection.
 */
export function openDirectPeer(
  options: DirectPeerOptions,
): Promise<DirectPeer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(
        new DirectPeerError("aborted", "Direct peer establishment aborted"),
      );
      return;
    }
    const Constructor =
      options.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    if (!Constructor) {
      reject(
        new DirectPeerError("unavailable", "RTCPeerConnection is unavailable"),
      );
      return;
    }
    let connection: RTCPeerConnection;
    try {
      connection = new Constructor({
        ...options.rtcConfiguration,
        iceServers: [],
      });
    } catch (cause) {
      reject(
        new DirectPeerError(
          "negotiation-failed",
          "Could not create peer connection",
          { cause },
        ),
      );
      return;
    }
    const closeConnection = connection.close.bind(connection);
    let connected = false;
    let termination: DirectPeerError | undefined;
    let finishClosed!: () => void;
    const closed = new Promise<void>((done) => {
      finishClosed = done;
    });
    const pending = new Set<(error: DirectPeerError) => void>();
    const cleanupEstablishment = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const terminate = (error: DirectPeerError) => {
      if (termination) return;
      termination = error;
      cleanupEstablishment();
      connection.removeEventListener("connectionstatechange", stateChanged);
      for (const fail of pending) fail(error);
      pending.clear();
      closeConnection();
      finishClosed();
      if (!connected) reject(error);
    };
    const abort = () =>
      terminate(
        new DirectPeerError("aborted", "Direct peer establishment aborted"),
      );
    const peer: DirectPeer = {
      connection,
      closed,
      close: () =>
        terminate(new DirectPeerError("closed", "Direct peer closed")),
      openChannel: (label, init) =>
        new Promise((opened, failed) => {
          if (termination) {
            failed(termination);
            return;
          }
          let channel: RTCDataChannel;
          try {
            channel = connection.createDataChannel(label, init);
            channel.binaryType = "arraybuffer";
          } catch (cause) {
            failed(
              new DirectPeerError(
                "channel-failed",
                "Could not create data channel",
                { cause },
              ),
            );
            return;
          }
          const cleanup = () => {
            pending.delete(fail);
            channel.removeEventListener("open", onOpen);
            channel.removeEventListener("close", onClose);
            channel.removeEventListener("error", onError);
          };
          const fail = (error: DirectPeerError) => {
            cleanup();
            failed(error);
          };
          const onOpen = () => {
            cleanup();
            opened(channel);
          };
          const onClose = () =>
            fail(
              new DirectPeerError(
                "channel-failed",
                "Data channel closed before opening",
              ),
            );
          const onError = () =>
            fail(
              new DirectPeerError(
                "channel-failed",
                "Data channel failed before opening",
              ),
            );
          pending.add(fail);
          channel.addEventListener("open", onOpen);
          channel.addEventListener("close", onClose);
          channel.addEventListener("error", onError);
          if (channel.readyState === "open") onOpen();
          else if (
            channel.readyState === "closed" ||
            channel.readyState === "closing"
          )
            onClose();
        }),
    };
    const stateChanged = () => {
      if (connection.connectionState === "failed")
        terminate(
          new DirectPeerError(
            "connection-failed",
            "Direct peer connection failed",
          ),
        );
      else if (connection.connectionState === "closed")
        terminate(
          new DirectPeerError("closed", "Direct peer connection closed"),
        );
      else if (
        connection.connectionState === "connected" &&
        !termination &&
        !connected
      ) {
        connected = true;
        cleanupEstablishment();
        resolve(peer);
      }
    };
    const timer = setTimeout(
      () =>
        terminate(
          new DirectPeerError("timeout", "Direct peer establishment timed out"),
        ),
      options.timeoutMs ?? 15000,
    );
    connection.addEventListener("connectionstatechange", stateChanged);
    options.signal?.addEventListener("abort", abort, { once: true });
    // Native close() emits no connectionstatechange; keep the exposed method in our lifecycle.
    connection.close = peer.close;
    void (async () => {
      try {
        const fingerprint =
          typeof options.fingerprint === "string"
            ? parseFingerprint(options.fingerprint)
            : options.fingerprint;
        const credentials = await deriveIceCredentials(fingerprint);
        if (termination) return;
        connection.createDataChannel("direct-peer").binaryType = "arraybuffer";
        const offer = await connection.createOffer();
        if (termination) return;
        await connection.setLocalDescription(offer);
        if (termination) return;
        await connection.setRemoteDescription({
          type: "answer",
          sdp: buildLiteAnswer(offer.sdp ?? "", {
            ip: options.host,
            port: options.port,
            fingerprint,
            credentials,
          }),
        });
        stateChanged();
      } catch (cause) {
        terminate(
          cause instanceof DirectPeerError
            ? cause
            : new DirectPeerError(
                "negotiation-failed",
                "Direct peer negotiation failed",
                { cause },
              ),
        );
      }
    })();
  });
}
