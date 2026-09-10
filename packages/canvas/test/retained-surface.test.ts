import { describe, expect, it } from "vitest";
import {
  createCanvasExecutor,
  createDrawList,
  createQuadView,
  createReplayMaskScratch,
  createRetainedSurface,
  snapRetainedSize,
} from "../src/index";
import { createFakeGl, fakeProjection } from "./fake-gl";

describe("retained RGBA8 surface", () => {
  function partialMask<T>(list: ReturnType<typeof createDrawList<T>>) {
    return createReplayMaskScratch(list.count).select(
      list,
      { x: 10, y: 20, width: 5, height: 6 },
      { maxCommands: list.count },
    );
  }

  it("allocates an exact snapped RGBA8 FBO and presents it 1:1", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    expect(surface.resize(100.4, 50.6)).toBe(true);
    expect([surface.width, surface.height]).toEqual([100, 51]);
    const allocation = fake.named("texImage2D").at(-1)?.args;
    expect(allocation?.slice(0, 6)).toEqual([
      fake.gl.TEXTURE_2D,
      0,
      fake.gl.RGBA8,
      100,
      51,
      0,
    ]);
    expect(surface.allocated).toBe(true);
    expect(surface.contentValid).toBe(false);
    expect(surface.present()).toBe(false);
    const executor = createCanvasExecutor({ gl: fake.gl });
    expect(
      surface.replay(executor, createDrawList(), fakeProjection(100, 51)),
    ).toBe(true);
    expect(surface.contentValid).toBe(true);
    fake.reset();
    expect(surface.present()).toBe(true);
    const disabledScissorAt = fake.calls.findIndex(
      (call) =>
        call.name === "disable" && call.args[0] === fake.gl.SCISSOR_TEST,
    );
    const blitAt = fake.calls.findIndex(
      (call) => call.name === "blitFramebuffer",
    );
    expect(disabledScissorAt).toBeGreaterThan(-1);
    expect(disabledScissorAt).toBeLessThan(blitAt);
    expect(fake.named("blitFramebuffer").at(-1)?.args).toEqual([
      0,
      0,
      100,
      51,
      0,
      0,
      100,
      51,
      fake.gl.COLOR_BUFFER_BIT,
      fake.gl.NEAREST,
    ]);
  });

  it("keeps direct executor frames separate from FBO seeding and presentation", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    const list = createDrawList();
    const quad = createQuadView();
    quad.w = 10;
    quad.h = 10;
    list.pushQuad(quad);
    executor.execute(list, fakeProjection(100, 100));
    expect(fake.named("bindFramebuffer")).toEqual([]);
    expect(fake.named("blitFramebuffer")).toEqual([]);
  });

  it("refuses a masked full clear as a seed", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    const executor = createCanvasExecutor({ gl: fake.gl });
    surface.resize(100, 100);
    expect(
      surface.replay(executor, createDrawList(), fakeProjection(100, 100), {
        // This is a valid scratch, but all masks are still forbidden for a
        // seed: only an unmasked complete replay may establish FBO pixels.
        mask: createReplayMaskScratch(),
      }),
    ).toBe(false);
    expect(surface.contentValid).toBe(false);
    expect(fake.named("clear")).toEqual([]);
  });

  it("refuses an unselected scratch instead of clearing a damaged tile", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    const executor = createCanvasExecutor({ gl: fake.gl });
    const list = createDrawList();
    surface.resize(100, 100);
    expect(surface.replay(executor, list, fakeProjection(100, 100))).toBe(true);
    fake.reset();
    expect(
      surface.replay(executor, list, fakeProjection(100, 100), {
        damage: { x: 10, y: 20, width: 5, height: 6 },
        mask: createReplayMaskScratch(),
      }),
    ).toBe(false);
    expect(fake.named("clear")).toEqual([]);
  });

  it("refuses a mask after its draw-list changes structurally or by source", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    const executor = createCanvasExecutor({ gl: fake.gl });
    const list = createDrawList();
    const view = createQuadView();
    view.w = 10;
    view.h = 10;
    const index = list.pushQuad(view);
    surface.resize(100, 100);
    expect(surface.replay(executor, list, fakeProjection(100, 100))).toBe(true);
    const sourceMask = partialMask(list);
    list.patchQuadColor(index, 0.5, 0.5, 0.5, 0.5);
    expect(
      surface.replay(executor, list, fakeProjection(100, 100), {
        damage: { x: 10, y: 20, width: 5, height: 6 },
        mask: sourceMask,
      }),
    ).toBe(false);
    const structuralMask = partialMask(list);
    list.pushQuad(view);
    expect(
      surface.replay(executor, list, fakeProjection(100, 100), {
        damage: { x: 10, y: 20, width: 5, height: 6 },
        mask: structuralMask,
      }),
    ).toBe(false);
  });

  it("restores the default framebuffer after a failed replay", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    surface.resize(100, 100);
    const declined = { execute: () => false } as unknown as ReturnType<
      typeof createCanvasExecutor
    >;
    expect(
      surface.replay(declined, createDrawList(), fakeProjection(100, 100)),
    ).toBe(false);
    expect(fake.named("bindFramebuffer").at(-1)?.args).toEqual([
      fake.gl.FRAMEBUFFER,
      null,
    ]);
  });

  it("requires a full seed before partial replay and refuses a mismatched projection", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    const executor = createCanvasExecutor({ gl: fake.gl });
    const list = createDrawList();
    const quad = createQuadView();
    quad.w = 100;
    quad.h = 100;
    list.pushQuad(quad);
    surface.resize(100, 100);
    expect(
      surface.replay(executor, list, fakeProjection(100, 100), {
        damage: { x: 10, y: 20, width: 5, height: 6 },
        mask: partialMask(list),
      }),
    ).toBe(false);
    expect(surface.replay(executor, list, fakeProjection(100, 100))).toBe(true);
    expect(surface.contentValid).toBe(true);
    fake.reset();
    expect(
      surface.replay(executor, list, fakeProjection(100, 100), {
        damage: { x: 10, y: 20, width: 5, height: 6 },
        mask: partialMask(list),
      }),
    ).toBe(true);
    expect(fake.named("clear")).toHaveLength(1);
    expect(
      fake.named("scissor").some((call) => call.args.join(",") === "10,74,5,6"),
    ).toBe(true);
    expect(surface.replay(executor, list, fakeProjection(50, 50))).toBe(false);
    surface.invalidateContent();
    expect(surface.allocated).toBe(true);
    expect(surface.contentValid).toBe(false);
    expect(surface.present()).toBe(false);
  });

  it("does not preserve pixels after a partial replay declines", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    const list = createDrawList();
    const view = createQuadView();
    view.w = 100;
    view.h = 100;
    list.pushQuad(view);
    surface.resize(100, 100);
    const executor = createCanvasExecutor({ gl: fake.gl });
    expect(surface.replay(executor, list, fakeProjection(100, 100))).toBe(true);
    const declined = { execute: () => false } as unknown as ReturnType<
      typeof createCanvasExecutor
    >;
    expect(
      surface.replay(declined, list, fakeProjection(100, 100), {
        damage: { x: 10, y: 20, width: 5, height: 6 },
        mask: partialMask(list),
      }),
    ).toBe(false);
    expect(surface.contentValid).toBe(false);
    expect(surface.present()).toBe(false);
  });

  it("replays an exact region set in one retained binding", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    const executor = createCanvasExecutor({ gl: fake.gl });
    const list = createDrawList();
    const view = createQuadView();
    view.w = 100;
    view.h = 100;
    list.pushQuad(view);
    surface.resize(100, 100);
    expect(surface.replay(executor, list, fakeProjection(100, 100))).toBe(true);
    fake.reset();

    expect(
      surface.replayRegions(executor, list, fakeProjection(100, 100), [
        {
          damage: { x: 0, y: 0, width: 20, height: 20 },
          mask: partialMask(list),
        },
        {
          damage: { x: 40, y: 40, width: 20, height: 20 },
          mask: partialMask(list),
        },
      ]),
    ).toBe(true);
    expect(fake.named("bindFramebuffer")).toHaveLength(2);
    expect(fake.named("bindFramebuffer").at(-1)?.args).toEqual([
      fake.gl.FRAMEBUFFER,
      null,
    ]);
    expect(fake.named("clear")).toHaveLength(2);
    expect(surface.present()).toBe(true);
    expect(fake.named("blitFramebuffer")).toHaveLength(1);
  });

  it("prevalidates every region before the first retained clear", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    const executor = createCanvasExecutor({ gl: fake.gl });
    const list = createDrawList();
    const view = createQuadView();
    view.w = 100;
    view.h = 100;
    list.pushQuad(view);
    surface.resize(100, 100);
    expect(surface.replay(executor, list, fakeProjection(100, 100))).toBe(true);
    fake.reset();

    expect(
      surface.replayRegions(executor, list, fakeProjection(100, 100), [
        {
          damage: { x: 0, y: 0, width: 20, height: 20 },
          mask: partialMask(list),
        },
        {
          damage: { x: 40, y: 40, width: 20, height: 20 },
          mask: createReplayMaskScratch(),
        },
      ]),
    ).toBe(false);
    expect(surface.contentValid).toBe(false);
    expect(fake.named("bindFramebuffer")).toEqual([]);
    expect(fake.named("clear")).toEqual([]);
    expect(surface.present()).toBe(false);
  });

  it("invalidates and restores the stage after a later region declines", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    const list = createDrawList();
    const view = createQuadView();
    view.w = 100;
    view.h = 100;
    list.pushQuad(view);
    const seed = createCanvasExecutor({ gl: fake.gl });
    surface.resize(100, 100);
    expect(surface.replay(seed, list, fakeProjection(100, 100))).toBe(true);
    fake.reset();
    let executions = 0;
    const declinesSecond = {
      execute: () => ++executions < 2,
    } as unknown as ReturnType<typeof createCanvasExecutor>;

    expect(
      surface.replayRegions(declinesSecond, list, fakeProjection(100, 100), [
        {
          damage: { x: 0, y: 0, width: 20, height: 20 },
          mask: partialMask(list),
        },
        {
          damage: { x: 40, y: 40, width: 20, height: 20 },
          mask: partialMask(list),
        },
      ]),
    ).toBe(false);
    expect(surface.contentValid).toBe(false);
    expect(fake.named("bindFramebuffer").at(-1)?.args).toEqual([
      fake.gl.FRAMEBUFFER,
      null,
    ]);
    expect(surface.present()).toBe(false);
  });

  it("invalidates retained pixels on resize and drops context handles without GL deletes", () => {
    const fake = createFakeGl();
    const surface = createRetainedSurface(fake.gl);
    const executor = createCanvasExecutor({ gl: fake.gl });
    surface.resize(100, 100);
    expect(
      surface.replay(executor, createDrawList(), fakeProjection(100, 100)),
    ).toBe(true);
    expect(surface.contentValid).toBe(true);
    expect(surface.resize(101, 100)).toBe(true);
    expect(surface.contentValid).toBe(false);
    fake.reset();
    surface.invalidate();
    expect(surface.allocated).toBe(false);
    expect(surface.present()).toBe(false);
    expect(fake.named("deleteFramebuffer")).toEqual([]);
    expect(fake.named("deleteTexture")).toEqual([]);
  });

  it("snaps invalid sizes to a live one-pixel allocation", () => {
    expect(snapRetainedSize(0)).toBe(1);
    expect(snapRetainedSize(-20)).toBe(1);
    expect(snapRetainedSize(Number.NaN)).toBe(1);
  });
});
