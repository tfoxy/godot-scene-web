import { describe, expect, it, vi } from "vitest";
import { createPixiDiagnostics } from "../src/pixi-diagnostics";

function commandGl() {
  return { FRAMEBUFFER: 1, DRAW_FRAMEBUFFER: 2, STENCIL_TEST: 3, SCISSOR_TEST: 4,
    drawElements: vi.fn(), drawArrays: vi.fn(), stencilOp: vi.fn(), scissor: vi.fn(),
    enable: vi.fn(), disable: vi.fn(), blendFunc: vi.fn(), texImage2D: vi.fn(),
    bindFramebuffer: vi.fn() };
}

describe("Pixi opt-in diagnostics", () => {
  it("samples synchronous Pixi operations without touching GL or unsampled submissions", () => {
    const gl = commandGl(), originalDraw = gl.drawElements, onFrame = vi.fn();
    const renderer = {
      renderGroup: {
        _buildInstructions() {},
        _updateRenderGroups(this: { _buildInstructions(): void }) { this._buildInstructions(); },
      },
      renderPipes: { batch: { upload() {}, execute() {} } },
      stencil: { setStencilMode() {} },
      texture: { onSourceUpdate() {} },
      geometry: { draw() {} },
    };
    const originalUpdate = renderer.renderGroup._updateRenderGroups;
    const d = createPixiDiagnostics(gl as unknown as WebGL2RenderingContext,
      { mode: "cpu-ops", sampleEvery: 2, onFrame }, renderer)!;
    const submit = () => {
      renderer.renderGroup._updateRenderGroups();
      renderer.renderPipes.batch.upload(); renderer.renderPipes.batch.execute();
      renderer.stencil.setStencilMode(); renderer.texture.onSourceUpdate();
      renderer.geometry.draw();
    };
    d.render(submit);
    d.render(submit);
    d.render(submit);
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls.map(([frame]) => frame.frameId)).toEqual([1, 3]);
    expect(onFrame.mock.calls[0][0]).toMatchObject({ completed: true, operations: {
      renderGroupUpdate: { calls: 1 }, instructionBuild: { calls: 1 },
      batchUpload: { calls: 1 }, batchExecute: { calls: 1 },
      stencilState: { calls: 1 }, textureUpload: { calls: 1 }, geometryDraw: { calls: 1 },
    } });
    expect(onFrame.mock.calls[0][0].totalRenderMs).toBeGreaterThanOrEqual(0);
    expect(renderer.renderGroup._updateRenderGroups).toBe(originalUpdate);
    expect(gl.drawElements).toBe(originalDraw);
    d.dispose();
  });

  it("restores Pixi methods after a failed sampled submission", () => {
    const onFrame = vi.fn();
    const renderer = { geometry: { draw() { throw new Error("draw failed"); } } };
    const original = renderer.geometry.draw;
    const d = createPixiDiagnostics(undefined, { mode: "cpu-ops", onFrame }, renderer)!;
    expect(() => d.render(() => renderer.geometry.draw())).toThrow("draw failed");
    expect(renderer.geometry.draw).toBe(original);
    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ frameId: 1, completed: false,
      operations: expect.objectContaining({ geometryDraw: expect.objectContaining({ calls: 1 }) }) }));
    d.dispose();
  });

  it("separates direct, offscreen, stencil and scissor commands and restores GL", () => {
    const gl = commandGl(), original = gl.drawElements, onFrame = vi.fn();
    const d = createPixiDiagnostics(gl as unknown as WebGL2RenderingContext,
      { mode: "commands", onFrame })!;
    d.render(() => {
      gl.enable(gl.STENCIL_TEST); gl.stencilOp(1, 2, 3); gl.drawElements();
      gl.disable(gl.STENCIL_TEST); gl.enable(gl.SCISSOR_TEST); gl.scissor();
      gl.bindFramebuffer(gl.FRAMEBUFFER, {} as WebGLFramebuffer); gl.drawElements();
      gl.blendFunc(); gl.texImage2D();
    }, ["group/a"]);
    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ frameId: 1, completed: true,
      directDraws: 1, offscreenDraws: 1, stencilDraws: 1, stencilChanges: 3,
      scissorChanges: 2, blendChanges: 1, textureUploads: 1,
      framebufferBinds: 1, cacheBakeCandidates: ["group/a"] }));
    d.dispose();
    expect(gl.drawElements).toBe(original);
  });

  it("records ordered Pixi batches with scene joins and unresolved split causes", () => {
    const onFrame = vi.fn();
    const markers: (string | null)[] = [];
    const globals = globalThis as typeof globalThis & { __gswPixiBatchMarker?: (marker: string | null) => void };
    globals.__gswPixiBatchMarker = marker => markers.push(marker);
    const renderer = { renderPipes: { batch: { execute: vi.fn() } } };
    const original = renderer.renderPipes.batch.execute;
    const known = { uid: 42 }, unknown = { uid: 43 };
    const batch = (start: number, blendMode: string, textures: number[], renderable: object) => ({
      action: start ? "renderBatch" : "startBatch", start, size: 6, blendMode,
      topology: "triangle-list", batcher: { maxTextures: 2 },
      textures: { count: textures.length, textures: textures.map(uid => ({ uid })) },
      elements: [{ renderable }],
    });
    const d = createPixiDiagnostics(undefined, { mode: "commands", onFrame }, renderer)!;
    d.render(() => {
      renderer.renderPipes.batch.execute(batch(0, "normal", [1], known));
      renderer.renderPipes.batch.execute(batch(6, "normal", [2], unknown));
      renderer.renderPipes.batch.execute(batch(12, "add", [2], known));
    }, [], renderable => renderable === known ? "quad/known" : null);
    const rows = onFrame.mock.calls[0][0].batches;
    expect(rows.map((row: { id: string }) => row.id)).toEqual(["1:0", "1:1", "1:2"]);
    expect(markers).toEqual(["gsw-pixi-batch:1:0", null, "gsw-pixi-batch:1:1", null,
      "gsw-pixi-batch:1:2", null]);
    expect(rows[0].renderables).toEqual([{ pixiUid: 42, nodeId: "quad/known" }]);
    expect(rows[1]).toMatchObject({ splitReasons: [], unresolvedJoin: true,
      renderables: [{ pixiUid: 43, nodeId: null }] });
    expect(rows[2]).toMatchObject({ splitReasons: ["blend-mode-change"], unresolvedJoin: false });
    d.dispose();
    delete globals.__gswPixiBatchMarker;
    expect(renderer.renderPipes.batch.execute).toBe(original);
  });

  it("reports unsupported and disjoint GPU timers as unavailable", () => {
    const onResult = vi.fn();
    const unsupported = createPixiDiagnostics(undefined, { mode: "gpu-timer", onResult })!;
    unsupported.render(() => {});
    expect(onResult).toHaveBeenLastCalledWith({ frameId: 1, elapsedMs: null, reason: "unsupported" });
    const ext = { TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 };
    let disjoint = false;
    const gl = { getExtension: () => ext, getParameter: () => disjoint,
      isContextLost: () => false, createQuery: () => ({}), beginQuery: vi.fn(), endQuery: vi.fn(),
      getQueryParameter: vi.fn(() => false), deleteQuery: vi.fn() };
    const d = createPixiDiagnostics(gl as unknown as WebGL2RenderingContext,
      { mode: "gpu-timer", onResult })!;
    d.render(() => {});
    disjoint = true; d.poll();
    expect(onResult).toHaveBeenLastCalledWith({ frameId: 1, elapsedMs: null, reason: "disjoint" });
    expect(gl.deleteQuery).toHaveBeenCalledOnce();
    d.dispose();
  });
});
