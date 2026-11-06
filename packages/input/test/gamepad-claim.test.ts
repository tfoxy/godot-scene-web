// @vitest-environment node
//
// `pads: "claim"` beyond what frame vectors express: the lock name and `ifAvailable`, the focus
// gate, two captures (same-origin windows) contending for one pad through a shared lock manager,
// disconnect and dispose handing the lock back, a stolen lock, and the per-window fallback.
import { describe, expect, it } from "vitest";
import { type GamepadSnapshot, padLockName } from "../src/gamepad";
import { FakeLocks, fakeGamepadPage, settle } from "./gamepad-fake";

const pad = (buttons: unknown[] = [], index = 0, id = "Pad A (STANDARD)") =>
  ({ mapping: "standard", buttons, axes: [], index, id }) as GamepadSnapshot;
const LOCK = "gsw-input/pad/0/Pad A (STANDARD)";

/** Press and release button 0 on `page`, letting the grant settle in between. */
async function claimOn(
  page: ReturnType<typeof fakeGamepadPage>,
  index = 0,
  id?: string,
) {
  page.step({ pads: [pad([1], index, id)] });
  await settle();
  page.step({ pads: [pad([0], index, id)] });
}

describe("pads: claim", () => {
  it("is the default", async () => {
    const page = fakeGamepadPage();
    expect(page.step({ pads: [pad([1])] })).toEqual([]);
    expect(page.capture.claims()).toEqual([
      {
        index: 0,
        id: "Pad A (STANDARD)",
        slot: 0,
        state: "pending",
        exclusive: true,
      },
    ]);
  });

  it("requests gsw-input/pad/<index>/<id> ifAvailable once per fresh press", async () => {
    expect(padLockName(3, "x/y")).toBe("gsw-input/pad/3/x/y");
    const page = fakeGamepadPage();
    page.step({ pads: [pad([1])] });
    page.step({ pads: [pad([1])] });
    expect(page.locks.requests).toEqual([LOCK]);
    await settle();
    expect(page.locks.held.has(LOCK)).toBe(true);
    expect(page.capture.claims()).toMatchObject([
      { state: "held", exclusive: true },
    ]);
  });

  it("claims nothing while unfocused, and reports nothing for unclaimed pads", async () => {
    const page = fakeGamepadPage();
    page.document.focused = false;
    page.step({ pads: [pad([1])] });
    await settle();
    page.step({ pads: [pad([0])] });
    page.step({ pads: [pad([1])] });
    expect(page.locks.requests).toEqual([]);
    expect(page.records).toEqual([]);
    expect(page.capture.heldState()).toEqual([]);
    expect(page.capture.claims()).toEqual([]);
  });

  it("gives one pad to exactly one of two windows", async () => {
    const locks = new FakeLocks();
    const a = fakeGamepadPage({ locks });
    const b = fakeGamepadPage({ locks });
    // The press reaches both windows, but only the focused one claims.
    b.document.focused = false;
    a.step({ pads: [pad([1])] });
    b.step({ pads: [pad([1])] });
    await settle();
    a.step({ pads: [pad([0])] });
    b.step({ pads: [pad([0])] });
    // Focus moves to b and the user presses there: the lock is taken, so b stays empty.
    a.document.focused = false;
    b.document.focused = true;
    a.step({ pads: [pad([1])] });
    b.step({ pads: [pad([1])] });
    await settle();
    expect(locks.requests).toEqual([LOCK, LOCK]);
    expect(a.records).toEqual([
      { event: "joypad_button", device: 0, button_index: 0, pressed: true },
    ]);
    expect(b.records).toEqual([]);
    expect(b.capture.claims()).toEqual([]);
    // a goes away; b's next fresh press claims it.
    a.capture.dispose();
    await settle();
    expect(locks.held.has(LOCK)).toBe(false);
    b.step({ pads: [pad([0])] });
    await claimOn(b);
    expect(b.capture.claims()).toMatchObject([{ state: "held", slot: 0 }]);
    expect(b.step({ pads: [pad([1])] })).toEqual([
      { event: "joypad_button", device: 0, button_index: 0, pressed: true },
    ]);
  });

  it("two pads pressed in two windows land one in each, both on slot 0", async () => {
    const locks = new FakeLocks();
    const a = fakeGamepadPage({ locks });
    const b = fakeGamepadPage({ locks });
    const both = (pa: unknown[], pb: unknown[]) => ({
      pads: [pad(pa, 0, "A"), pad(pb, 1, "B")],
    });
    b.document.focused = false;
    a.step(both([1], [0]));
    b.step(both([1], [0]));
    await settle();
    a.document.focused = false;
    b.document.focused = true;
    a.step(both([0], [1]));
    b.step(both([0], [1]));
    await settle();
    expect(a.capture.claims()).toMatchObject([{ id: "A", slot: 0 }]);
    expect(b.capture.claims()).toMatchObject([{ id: "B", slot: 0 }]);
    a.step(both([0], [0]));
    b.step(both([0], [0]));
    expect(a.step(both([1], [1]))).toEqual([
      { event: "joypad_button", device: 0, button_index: 0, pressed: true },
    ]);
    expect(b.step(both([1], [1]))).toEqual([
      { event: "joypad_button", device: 0, button_index: 0, pressed: true },
    ]);
  });

  it("hands the lock back on disconnect", async () => {
    const page = fakeGamepadPage();
    await claimOn(page);
    expect(page.locks.held.has(LOCK)).toBe(true);
    page.step({ pads: [] });
    await settle();
    expect(page.locks.held.has(LOCK)).toBe(false);
    expect(page.capture.claims()).toEqual([]);
  });

  it("hands the lock back on a disconnect while hidden (no poll runs)", async () => {
    const page = fakeGamepadPage();
    await claimOn(page);
    page.step({ pads: [pad([0])], visibility: "hidden" });
    expect(page.pending()).toBe(false);
    page.step({ pads: [] });
    await settle();
    expect(page.locks.held.has(LOCK)).toBe(false);
  });

  it("treats a different id at the same index as another pad", async () => {
    const page = fakeGamepadPage();
    await claimOn(page, 0, "old");
    page.step({ pads: [pad([1], 0, "new")] });
    await settle();
    expect(page.capture.claims()).toMatchObject([{ id: "new", slot: 0 }]);
    expect(page.locks.held.has("gsw-input/pad/0/old")).toBe(false);
  });

  it("hands every lock back on dispose", async () => {
    const page = fakeGamepadPage();
    await claimOn(page);
    page.capture.dispose();
    await settle();
    expect(page.locks.held.size).toBe(0);
    expect(page.capture.claims()).toEqual([]);
  });

  it("returns a lock granted after dispose at once", async () => {
    const page = fakeGamepadPage();
    page.step({ pads: [pad([1])] });
    page.capture.dispose();
    await settle();
    expect(page.locks.requests).toEqual([LOCK]);
    expect(page.locks.held.size).toBe(0);
  });

  it("ends the claim when the lock is stolen", async () => {
    const page = fakeGamepadPage();
    await claimOn(page);
    page.step({ pads: [pad([1])] });
    page.locks.steal(LOCK);
    await settle();
    expect(page.capture.claims()).toEqual([]);
    expect(page.step({ pads: [pad([1])] })).toEqual([
      { event: "joypad_button", device: 0, button_index: 0, pressed: false },
    ]);
  });

  it("does not claim past maxSlots", async () => {
    const page = fakeGamepadPage({ maxSlots: 1 });
    await claimOn(page, 0, "A");
    page.step({ pads: [pad([0], 0, "A"), pad([1], 1, "B")] });
    await settle();
    expect(page.capture.claims()).toMatchObject([{ id: "A" }]);
    expect(page.locks.requests).toHaveLength(1);
  });

  it("falls back to per-window claims without a lock manager", () => {
    const page = fakeGamepadPage({ locks: null });
    page.step({ pads: [pad([1])] });
    expect(page.capture.claims()).toMatchObject([
      { state: "held", exclusive: false },
    ]);
  });

  it("falls back to per-window claims when the lock manager rejects", async () => {
    const page = fakeGamepadPage();
    page.locks.failing = true;
    page.step({ pads: [pad([1])] });
    await settle();
    expect(page.capture.claims()).toMatchObject([
      { state: "held", exclusive: false },
    ]);
    // Later claims skip the broken manager.
    page.step({ pads: [pad([0]), pad([1], 1, "B")] });
    expect(page.locks.requests).toEqual([LOCK]);
    expect(page.capture.claims()).toHaveLength(2);
  });

  it("falls back to per-window claims when the lock manager throws", () => {
    const page = fakeGamepadPage({
      locks: {
        request() {
          throw new Error("SecurityError");
        },
      },
    });
    page.step({ pads: [pad([1])] });
    expect(page.capture.claims()).toMatchObject([
      { state: "held", exclusive: false },
    ]);
  });

  it("each and merge report no claims", () => {
    for (const pads of ["each", "merge"] as const) {
      const page = fakeGamepadPage({ pads });
      page.step({ pads: [pad([1])] });
      expect(page.capture.claims()).toEqual([]);
      expect(page.locks.requests).toEqual([]);
    }
  });
});
