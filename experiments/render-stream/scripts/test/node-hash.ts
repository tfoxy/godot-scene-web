// Importing this module swaps the pure-JS sha256 the render-stream decoders default to (what a browser
// bundle needs) for node:crypto's, in all three payload modules. The digests are identical
// (self-test-browser-decoder.ts proves it on every golden payload and 10 000 random lengths); the
// heavy self-tests hash megabytes of fixture payload per scenario, where the JS implementation was
// ~18% of gate 2's CPU. Self-tests only: the checkers keep their defaults.
import { createHash } from "node:crypto";
import { setHashImpl } from "../lib/render-stream-2";
import { setHashImpl as setMeshHashImpl } from "../lib/render-stream-mesh";
import { setHashImpl as setShaderHashImpl } from "../lib/render-stream-shader";

const nodeSha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
setHashImpl(nodeSha256);
setMeshHashImpl(nodeSha256);
setShaderHashImpl(nodeSha256);
