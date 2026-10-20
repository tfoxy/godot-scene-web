// G7k sabotage `leak-gl-textures` (gsw only, gate7-design.md Q10 soak). It never touches the
// canvas or WebGL2 context GSW draws into -- it leaks real GL objects on a throwaway, invisible
// context of its own, so the real rendering pipeline (and every other check) is unaffected. The
// leaked textures still cost real GPU memory (nvidia-smi sees it, `gpu-mem-bounded`) and the
// count below never falls (`residency-bounded`'s GL-texture half), because this module never
// calls `deleteTexture` on them -- that omission IS the sabotage; there is nothing else to get
// wrong, which is why this is a few lines instead of a context-intercepting proxy.
//
// Sizing (Q10's 300-s soak, one leak call roughly every 2 s from the live loop's 1 Hz tick,
// `shouldLeakNow`): a 512x512 RGBA8 texture is 1 MiB. ~150 calls over the 300-s window is
// ~150 MiB, comfortably over the 8 MiB `gpu-mem-bounded` budget and the residency check's growth
// window, without approaching this box's VRAM.

const LEAK_TEXTURE_SIZE = 512;
const LEAK_PIXELS = new Uint8Array(LEAK_TEXTURE_SIZE * LEAK_TEXTURE_SIZE * 4).fill(127);
const LEAK_INTERVAL_MS = 2000;

let gl: WebGL2RenderingContext | null = null;
let glInitTried = false;
let leaked = 0;
let nextLeakAtMs = -1;

function leakContext(): WebGL2RenderingContext | null {
  if (!glInitTried) {
    glInitTried = true;
    const canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl2");
  }
  return gl;
}

/** One more real, never-deleted texture, if the sabotage's own pacing says it is due. Safe to
 * call on every tick (it is its own gate); a context that could not be created (never observed
 * with WebGL2 already provisioned for the real receiver) leaves the count at 0, never throws. */
export function leakOneIfDue(nowMs: number): number {
  if (nextLeakAtMs >= 0 && nowMs < nextLeakAtMs) return leaked;
  nextLeakAtMs =
    nextLeakAtMs < 0
      ? nowMs + LEAK_INTERVAL_MS
      : nextLeakAtMs + LEAK_INTERVAL_MS;
  const g = leakContext();
  if (g === null) return leaked;
  const texture = g.createTexture();
  if (texture === null) return leaked;
  g.bindTexture(g.TEXTURE_2D, texture);
  g.texImage2D(
    g.TEXTURE_2D,
    0,
    g.RGBA,
    LEAK_TEXTURE_SIZE,
    LEAK_TEXTURE_SIZE,
    0,
    g.RGBA,
    g.UNSIGNED_BYTE,
    LEAK_PIXELS,
  );
  // Real data and a finish(): a null-data texImage2D can stay lazy in the driver, and nvidia-smi
  // (gpu-mem-bounded) must see the allocation.
  // One draw per leaked texture: attach it to a framebuffer, clear and read a pixel back, so the
  // driver cannot keep the allocation lazy (an unbound/undrawn texture may never get memory).
  const fbo = g.createFramebuffer();
  g.bindFramebuffer(g.FRAMEBUFFER, fbo);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);
  g.clearColor(0.25, 0.5, 0.75, 1);
  g.clear(g.COLOR_BUFFER_BIT);
  g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array(4));
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  g.deleteFramebuffer(fbo);
  g.finish();
  // No `deleteTexture`: the leak. `bindTexture(null)` only releases the binding point, not the
  // object, so the GPU allocation this `texImage2D` made is kept whether or not this line runs.
  g.bindTexture(g.TEXTURE_2D, null);
  leaked++;
  return leaked;
}

export function leakedGlTextureCount(): number {
  return leaked;
}
