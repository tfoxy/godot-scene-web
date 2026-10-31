// INP1 (client-extensions-design.md "As built (INP1)"): the picture's layout on the page and the
// points across it. The letterbox maps to null, whatever the presentation's aspect.

import { describe, expect, it } from "vitest";
import {
  clientToPresentation,
  type PictureLayout,
  parseObjectFit,
  parseObjectPosition,
  pictureRect,
  presentationToClient,
  readLayout,
} from "../src/pointer";

const layout = (o: Partial<PictureLayout> & { box: PictureLayout["box"] }) =>
  ({
    fit: "contain",
    position: [{ fraction: 0.5 }, { fraction: 0.5 }],
    backing: [1920, 1080],
    presentation: [1920, 1080],
    ...o,
  }) as PictureLayout;

describe("picture layout", () => {
  it("contains a 16:9 picture in a taller box and maps the bars to null", () => {
    const l = layout({ box: { x: 100, y: 50, w: 960, h: 800 } });
    expect(pictureRect(l)).toEqual({
      x: 100,
      y: 50 + (800 - 540) / 2,
      w: 960,
      h: 540,
    });
    // The top bar is 130 px tall.
    expect(clientToPresentation(l, 500, 50 + 129)).toBeNull();
    expect(clientToPresentation(l, 500, 50 + 800 - 1)).toBeNull();
    // The picture's centre.
    expect(clientToPresentation(l, 100 + 480, 50 + 400)).toEqual({
      x: 960,
      y: 540,
    });
    // Its first pixel row.
    expect(clientToPresentation(l, 100, 180)).toEqual({ x: 0, y: 0 });
  });

  it("pillarboxes a wide box", () => {
    const l = layout({ box: { x: 0, y: 0, w: 1920, h: 540 } });
    const p = pictureRect(l);
    expect(p).toEqual({ x: 480, y: 0, w: 960, h: 540 });
    expect(clientToPresentation(l, 479, 100)).toBeNull();
    expect(clientToPresentation(l, 1440, 100)).toBeNull();
    expect(clientToPresentation(l, 480, 270)).toEqual({ x: 0, y: 540 });
  });

  it("works for a non-16:9 presentation (2340x1080 backing, 1:1)", () => {
    const l = layout({
      box: { x: 0, y: 0, w: 1170, h: 700 },
      backing: [2340, 1080],
      presentation: [2340, 1080],
    });
    const p = pictureRect(l);
    expect(p.w).toBe(1170);
    expect(p.h).toBe(540);
    expect(p.y).toBe(80);
    expect(clientToPresentation(l, 585, 350)).toEqual({ x: 1170, y: 540 });
    expect(clientToPresentation(l, 585, 79)).toBeNull();
    // The rect a card occupies comes back to the page by the same scale.
    expect(
      presentationToClient(l, { x: 1170, y: 540, w: 234, h: 108 }),
    ).toEqual({ x: 585, y: 350, w: 117, h: 54 });
  });

  it("scales by the session's presentation when the backing differs", () => {
    // A backing of 1280x720 showing a 1920x1080 session: points are in the session's px.
    const l = layout({
      box: { x: 0, y: 0, w: 640, h: 360 },
      backing: [1280, 720],
      presentation: [1920, 1080],
    });
    expect(clientToPresentation(l, 320, 180)).toEqual({ x: 960, y: 540 });
  });

  it("stretches under fill, crops under cover, honours object-position", () => {
    const fill = layout({ fit: "fill", box: { x: 0, y: 0, w: 480, h: 540 } });
    expect(clientToPresentation(fill, 240, 270)).toEqual({ x: 960, y: 540 });
    const cover = layout({ fit: "cover", box: { x: 0, y: 0, w: 480, h: 540 } });
    // Scale 0.5: the picture is 960x540 centred in a 480-wide window onto it.
    expect(pictureRect(cover)).toEqual({ x: -240, y: 0, w: 960, h: 540 });
    expect(clientToPresentation(cover, 0, 0)).toEqual({ x: 480, y: 0 });
    const top = layout({
      box: { x: 0, y: 0, w: 960, h: 800 },
      position: parseObjectPosition("50% 0%"),
    });
    expect(pictureRect(top).y).toBe(0);
    expect(clientToPresentation(top, 10, 600)).toBeNull();
  });

  it("is null in an empty box", () => {
    expect(
      clientToPresentation(layout({ box: { x: 0, y: 0, w: 0, h: 0 } }), 0, 0),
    ).toBeNull();
  });

  it("parses object-position and object-fit", () => {
    expect(parseObjectPosition("50% 50%")).toEqual([
      { fraction: 0.5 },
      { fraction: 0.5 },
    ]);
    expect(parseObjectPosition("left top")).toEqual([
      { fraction: 0 },
      { fraction: 0 },
    ]);
    expect(parseObjectPosition("top left")).toEqual([
      { fraction: 0 },
      { fraction: 0 },
    ]);
    expect(parseObjectPosition("10px 20px")).toEqual([{ px: 10 }, { px: 20 }]);
    expect(parseObjectPosition("bottom")).toEqual([
      { fraction: 0.5 },
      { fraction: 1 },
    ]);
    expect(parseObjectFit("contain")).toBe("contain");
    expect(parseObjectFit("")).toBe("fill");
  });

  it("reads the canvas on demand", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1920;
    canvas.height = 1080;
    canvas.style.cssText =
      "width:960px;height:800px;object-fit:contain;padding:0;border:0";
    document.body.append(canvas);
    canvas.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 960, height: 800 }) as DOMRect;
    const l = readLayout(canvas, [1920, 1080]);
    expect(l.fit).toBe("contain");
    expect(l.backing).toEqual([1920, 1080]);
    expect(l.box.x).toBe(10);
    expect(l.box.y).toBe(20);
    canvas.remove();
  });
});
