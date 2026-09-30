/** Opt-in measurements for one Pixi WebGL submission. Command interception changes
 * submission overhead and must be run separately from GPU timing. */
export interface PixiCommandFrame {
  readonly frameId: number;
  readonly completed: boolean;
  readonly directDraws: number;
  readonly offscreenDraws: number;
  readonly stencilDraws: number;
  readonly stencilChanges: number;
  readonly scissorChanges: number;
  readonly blendChanges: number;
  readonly textureUploads: number;
  readonly framebufferBinds: number;
  readonly cacheBakeCandidates: readonly string[];
  /** Submission order, independent of Spector's WebGL command numbering. */
  readonly batches: readonly PixiBatchRecord[];
}

export interface PixiBatchRecord {
  readonly id: string;
  readonly marker: string;
  readonly ordinal: number;
  readonly action: string;
  readonly indexStart: number;
  readonly indexCount: number;
  readonly blendMode: string;
  readonly topology: string;
  readonly textureIds: readonly (number | string)[];
  readonly renderables: readonly { readonly pixiUid: number | string | null; readonly nodeId: string | null }[];
  /** Only observable state changes are named; a pipe break has no public reason. */
  readonly splitReasons: readonly string[];
  readonly unresolvedJoin: boolean;
}

export interface PixiGpuElapsed {
  readonly frameId: number;
  readonly elapsedMs: number | null;
  readonly reason?: "unsupported" | "disjoint" | "context-lost" | "query-failed";
}

/** Synchronous JavaScript and WebGL driver-entry wall time, not asynchronous GPU time.
 * Buckets are inclusive and may overlap (e.g. instruction build occurs during
 * render-group update, and geometry draw may occur during batch execution). */
export interface PixiCpuFrame {
  readonly frameId: number;
  readonly completed: boolean;
  readonly totalRenderMs: number;
  readonly operations: Readonly<Record<PixiCpuOperation, { readonly calls: number; readonly wallMs: number }>>;
}

export type PixiCpuOperation = "renderGroupUpdate" | "instructionBuild" | "batchUpload" |
  "batchExecute" | "stencilState" | "textureUpload" | "geometryDraw";

export type PixiDiagnostics =
  | { readonly mode: "commands"; readonly onFrame: (frame: PixiCommandFrame) => void }
  | { readonly mode: "gpu-timer"; readonly onResult: (result: PixiGpuElapsed) => void }
  | { readonly mode: "cpu-ops"; readonly onFrame: (frame: PixiCpuFrame) => void;
      /** Sample one in N submissions, beginning with frame 1. Defaults to 30. */
      readonly sampleEvery?: number };

type TimerExtension = { readonly TIME_ELAPSED_EXT: number; readonly GPU_DISJOINT_EXT: number };
type Pending = { id: number; query: WebGLQuery };

export function createPixiDiagnostics(gl: WebGL2RenderingContext | undefined, config: PixiDiagnostics | undefined,
  renderer?: object) {
  if (!config) return null;
  const commandConfig = config.mode === "commands" ? config : null;
  const timerConfig = config.mode === "gpu-timer" ? config : null;
  const cpuConfig = config.mode === "cpu-ops" ? config : null;
  const cpuEvery = cpuConfig && Number.isSafeInteger(cpuConfig.sampleEvery) && (cpuConfig.sampleEvery ?? 0) > 0
    ? cpuConfig.sampleEvery! : 30;
  let nextId = 0;
  const original = new Map<string, (...args: any[]) => any>();
  let active: { frameId: number; completed: boolean; directDraws: number; offscreenDraws: number;
    stencilDraws: number; stencilChanges: number; scissorChanges: number;
    blendChanges: number; textureUploads: number; framebufferBinds: number;
    cacheBakeCandidates: readonly string[]; batches: PixiBatchRecord[] } | null = null;
  let offscreen = false;
  let stencilEnabled = false;
  const pending: Pending[] = [];
  const batchPipe = cpuTarget("renderPipes.batch");
  const originalBatchExecute = commandConfig && batchPipe && typeof batchPipe.execute === "function"
    ? batchPipe.execute as (...args: any[]) => any : null;
  let resolveRenderable: ((renderable: object) => string | null) | undefined;
  if (originalBatchExecute && batchPipe) batchPipe.execute = function (this: unknown, batch: any) {
    if (active) {
      const previous = active.batches.at(-1);
      const textures = Array.from({ length: batch?.textures?.count ?? 0 }, (_, i) =>
        batch.textures.textures[i]?.uid ?? `unknown:${i}`) as (number | string)[];
      const renderables = (Array.isArray(batch?.elements) ? batch.elements : []).map((element: any) => {
        const renderable = element?.renderable;
        return { pixiUid: typeof renderable?.uid === "number" || typeof renderable?.uid === "string"
          ? renderable.uid : null,
        nodeId: renderable && typeof renderable === "object" ? resolveRenderable?.(renderable) ?? null : null };
      });
      const reasons: string[] = [];
      if (previous) {
        if (previous.blendMode !== String(batch?.blendMode)) reasons.push("blend-mode-change");
        if (previous.topology !== String(batch?.topology)) reasons.push("topology-change");
        // A different texture set may share one batch; it is evidence of a split
        // only when the preceding batch reached this batcher's texture limit.
        const max = batch?.batcher?.maxTextures;
        if (typeof max === "number" && previous.textureIds.length >= max &&
            textures.some((id) => !previous.textureIds.includes(id))) reasons.push("texture-limit");
      }
      const ordinal = active.batches.length;
      const id = `${active.frameId}:${ordinal}`;
      const marker = `gsw-pixi-batch:${id}`;
      active.batches.push({ id, marker, ordinal,
        action: String(batch?.action ?? "unknown"), indexStart: Number(batch?.start ?? -1),
        indexCount: Number(batch?.size ?? -1), blendMode: String(batch?.blendMode ?? "unknown"),
        topology: String(batch?.topology ?? "unknown"), textureIds: textures, renderables,
        splitReasons: reasons, unresolvedJoin: ordinal > 0 && reasons.length === 0 });
    }
    // The optional diagnostic hook is installed by a capture harness before
    // WebGL context creation. It is never read on the normal renderer path.
    const markerHook = (globalThis as typeof globalThis & {
      __gswPixiBatchMarker?: (marker: string | null) => void
    }).__gswPixiBatchMarker;
    if (active && markerHook) {
      const marker = active.batches.at(-1)!.marker;
      try { markerHook(marker); } catch { /* diagnostics cannot break rendering */ }
      try { return originalBatchExecute.apply(this, [batch]); }
      finally { try { markerHook(null); } catch { /* diagnostics cannot break rendering */ } }
    }
    return originalBatchExecute.apply(this, [batch]);
  };
  const cpuMethods: readonly [PixiCpuOperation, string, string][] = [
    ["renderGroupUpdate", "renderGroup", "_updateRenderGroups"],
    ["instructionBuild", "renderGroup", "_buildInstructions"],
    ["batchUpload", "renderPipes.batch", "upload"],
    ["batchExecute", "renderPipes.batch", "execute"],
    ["stencilState", "stencil", "setStencilMode"],
    ["textureUpload", "texture", "onSourceUpdate"],
    ["geometryDraw", "geometry", "draw"],
  ];
  function cpuTarget(path: string): Record<string, any> | null {
    let target: any = renderer;
    for (const part of path.split(".")) target = target?.[part];
    return target && typeof target === "object" ? target : null;
  }
  function captureCpu(submit: () => void, frameId: number) {
    const operations = Object.fromEntries(cpuMethods.map(([key]) => [key, { calls: 0, wallMs: 0 }])) as
      Record<PixiCpuOperation, { calls: number; wallMs: number }>;
    const restores: (() => void)[] = [];
    // Install wrappers for this one sampled submission only. Unsampled frames
    // execute Pixi's original methods without an extra call layer.
    try {
      for (const [key, path, method] of cpuMethods) {
        const target = cpuTarget(path);
        if (!target || typeof target[method] !== "function") continue;
        const owned = Object.prototype.hasOwnProperty.call(target, method);
        const originalMethod = target[method] as (...args: any[]) => any;
        target[method] = function (this: unknown, ...args: any[]) {
          const started = performance.now();
          try { return originalMethod.apply(this, args); }
          finally { operations[key].calls++; operations[key].wallMs += performance.now() - started; }
        };
        restores.push(() => { if (owned) target[method] = originalMethod; else delete target[method]; });
      }
      const started = performance.now();
      let completed = false;
      try { submit(); completed = true; }
      finally {
        cpuConfig?.onFrame({ frameId, completed, totalRenderMs: performance.now() - started, operations });
      }
    } finally {
      for (let i = restores.length - 1; i >= 0; i--) restores[i]();
    }
  }
  const ext = timerConfig && gl && typeof gl.getExtension === "function"
    ? gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExtension | null : null;
  function wrap(name: string, observe: (...args: any[]) => void) {
    if (!gl || typeof (gl as any)[name] !== "function") return;
    const before = (gl as any)[name] as (...args: any[]) => any;
    original.set(name, before);
    (gl as any)[name] = function (...args: any[]) { observe(...args); return before.apply(gl, args); };
  }
  if (commandConfig && gl) {
    for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"])
      wrap(name, () => { if (active) { active[offscreen ? "offscreenDraws" : "directDraws"]++;
        if (stencilEnabled) active.stencilDraws++; } });
    for (const name of ["stencilFunc", "stencilFuncSeparate", "stencilOp", "stencilOpSeparate", "stencilMask", "stencilMaskSeparate"])
      wrap(name, () => { if (active) active.stencilChanges++; });
    wrap("enable", (cap: number) => { if (cap === gl.STENCIL_TEST) { stencilEnabled = true; if (active) active.stencilChanges++; }
      if (cap === gl.SCISSOR_TEST && active) active.scissorChanges++; });
    wrap("disable", (cap: number) => { if (cap === gl.STENCIL_TEST) { stencilEnabled = false; if (active) active.stencilChanges++; }
      if (cap === gl.SCISSOR_TEST && active) active.scissorChanges++; });
    wrap("scissor", () => { if (active) active.scissorChanges++; });
    for (const name of ["blendFunc", "blendFuncSeparate", "blendEquation", "blendEquationSeparate"])
      wrap(name, () => { if (active) active.blendChanges++; });
    for (const name of ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D", "compressedTexImage2D", "compressedTexSubImage2D", "compressedTexImage3D", "compressedTexSubImage3D"])
      wrap(name, () => { if (active) active.textureUploads++; });
    wrap("bindFramebuffer", (target: number, framebuffer: WebGLFramebuffer | null) => {
      if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) offscreen = framebuffer !== null;
      if (active) active.framebufferBinds++;
    });
  }
  function poll() {
    if (!gl || !ext || !timerConfig) return;
    // Availability is checked before reading the result. A disjoint invalidates
    // every outstanding query; it is never reported as zero elapsed time.
    const disjoint = Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT));
    if (disjoint) {
      for (const item of pending.splice(0)) { gl.deleteQuery(item.query); timerConfig.onResult({ frameId: item.id, elapsedMs: null, reason: "disjoint" }); }
      return;
    }
    while (pending.length && gl.getQueryParameter(pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      const item = pending.shift()!;
      const ns = gl.getQueryParameter(item.query, gl.QUERY_RESULT) as number;
      gl.deleteQuery(item.query);
      timerConfig.onResult({ frameId: item.id, elapsedMs: Number.isFinite(ns) && ns >= 0 ? ns / 1e6 : null,
        ...(!Number.isFinite(ns) || ns < 0 ? { reason: "query-failed" as const } : {}) });
    }
  }
  function render(submit: () => void, cacheBakeCandidates: readonly string[] = [],
    nodeIdForRenderable?: (renderable: object) => string | null) {
    const frameId = ++nextId;
    resolveRenderable = nodeIdForRenderable;
    if (cpuConfig) {
      if ((frameId - 1) % cpuEvery === 0) captureCpu(submit, frameId);
      else submit();
      return;
    }
    if (commandConfig) active = { frameId, completed: false, directDraws: 0,
      offscreenDraws: 0, stencilDraws: 0, stencilChanges: 0, scissorChanges: 0,
      blendChanges: 0, textureUploads: 0,
      framebufferBinds: 0, cacheBakeCandidates, batches: [] };
    let query: WebGLQuery | null = null;
    if (timerConfig) {
      poll();
      if (!gl || !ext) timerConfig.onResult({ frameId, elapsedMs: null, reason: "unsupported" });
      else if (gl.isContextLost()) timerConfig.onResult({ frameId, elapsedMs: null, reason: "context-lost" });
      else if (pending.length < 4) {
        query = gl.createQuery();
        if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        else timerConfig.onResult({ frameId, elapsedMs: null, reason: "query-failed" });
      } else timerConfig.onResult({ frameId, elapsedMs: null, reason: "query-failed" });
    }
    try { submit(); if (active) active.completed = true; }
    finally {
      if (query && gl && ext) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pending.push({ id: frameId, query });
      }
      if (active && commandConfig) { commandConfig.onFrame(active); active = null; }
      resolveRenderable = undefined;
    }
  }
  function dispose() {
    if (batchPipe && originalBatchExecute) batchPipe.execute = originalBatchExecute;
    if (gl) {
      for (const [name, fn] of original) (gl as any)[name] = fn;
      for (const item of pending.splice(0)) gl.deleteQuery(item.query);
    }
    active = null;
  }
  return { render, poll, dispose };
}
