// GRT4b: the checkers run under Node, so the decoders' hash seam (G7j: render-stream-2.ts,
// render-stream-mesh.ts and render-stream-shader.ts each default to sha256.ts's pure-JS SHA-256,
// which keeps them browser-loadable) gets node:crypto instead. The digests are the same bytes;
// the pure one was a third of gate 2's checker time (results/grt.md "Part 4b"). Every
// check-gate*.ts imports this module first, for its side effect.
import { createHash } from "node:crypto";
import { setHashImpl as setRs2HashImpl } from "./render-stream-2";
import { setHashImpl as setMeshHashImpl } from "./render-stream-mesh";
import { setHashImpl as setShaderHashImpl } from "./render-stream-shader";

export function nodeSha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function useNodeHash(): void {
  setRs2HashImpl(nodeSha256Hex);
  setMeshHashImpl(nodeSha256Hex);
  setShaderHashImpl(nodeSha256Hex);
}

useNodeHash();
