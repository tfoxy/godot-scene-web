import { describe, expect, it } from "vitest";
import { collectDomTree } from "../src/browser";
import { compareLiveTreeToDomTree } from "../src/index";

describe("compareLiveTreeToDomTree", () => {
  it("matches live and DOM trees by Godot path and rect", () => {
    const result = compareLiveTreeToDomTree(
      [
        {
          path: "Panel",
          type: "ColorRect",
          parentPath: ".",
          visible: true,
          rect: { x: 10, y: 20, width: 100, height: 50 },
        },
      ],
      [
        {
          path: "Panel",
          type: "ColorRect",
          parentPath: ".",
          visible: true,
          rect: { x: 10.2, y: 19.9, width: 100, height: 50 },
        },
      ],
      { tolerancePx: 0.5 },
    );
    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  it("reports actionable mismatch codes", () => {
    const result = compareLiveTreeToDomTree(
      [
        {
          path: "Panel",
          type: "ColorRect",
          parentPath: ".",
          rect: { x: 10, y: 20, width: 100, height: 50 },
        },
      ],
      [
        {
          path: "Panel",
          type: "Panel",
          parentPath: ".",
          rect: { x: 30, y: 20, width: 100, height: 50 },
        },
      ],
      { tolerancePx: 0.5 },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((mismatch) => mismatch.code)).toEqual([
      "type-mismatch",
      "rect-x-mismatch",
    ]);
  });

  it("expects effectively hidden live nodes to be absent under expect-absent", () => {
    // Hidden parent + visible-flagged child: the whole subtree is effectively
    // hidden, so its absence from the DOM (the renderer prunes it to a comment)
    // is correct — no rect/type checks run for it.
    const result = compareLiveTreeToDomTree(
      [
        {
          path: ".",
          type: "Control",
          parentPath: null,
          visible: true,
          rect: { x: 0, y: 0, width: 100, height: 100 },
        },
        {
          path: "Hidden",
          type: "Control",
          parentPath: ".",
          visible: false,
          rect: { x: 10, y: 10, width: 50, height: 50 },
        },
        {
          path: "Hidden/Inner",
          type: "ColorRect",
          parentPath: "Hidden",
          visible: true,
          rect: { x: 10, y: 10, width: 20, height: 20 },
        },
      ],
      [
        {
          path: ".",
          type: "Control",
          parentPath: null,
          rect: { x: 0, y: 0, width: 100, height: 100 },
        },
      ],
      { tolerancePx: 0.5, hiddenLiveNodes: "expect-absent" },
    );
    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  it("reports a hidden live node that still rendered under expect-absent", () => {
    const result = compareLiveTreeToDomTree(
      [
        {
          path: "Hidden",
          type: "ColorRect",
          parentPath: null,
          visible: false,
          rect: { x: 10, y: 10, width: 50, height: 50 },
        },
      ],
      [
        {
          path: "Hidden",
          type: "ColorRect",
          parentPath: null,
          rect: { x: 10, y: 10, width: 50, height: 50 },
        },
      ],
      { tolerancePx: 0.5, hiddenLiveNodes: "expect-absent" },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((mismatch) => mismatch.code)).toEqual([
      "hidden-node-rendered",
    ]);
  });

  it("still reports visible live nodes missing from the DOM under expect-absent", () => {
    const result = compareLiveTreeToDomTree(
      [
        {
          path: "Shown",
          type: "ColorRect",
          parentPath: null,
          visible: true,
          rect: { x: 0, y: 0, width: 50, height: 50 },
        },
      ],
      [],
      { tolerancePx: 0.5, hiddenLiveNodes: "expect-absent" },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((mismatch) => mismatch.code)).toEqual([
      "missing-dom-node",
    ]);
  });

  it("compares hidden live nodes like any other in the default mode", () => {
    // The layout-tree oracle keeps the default: hidden nodes still have computed
    // rects there, and a missing one is a real mismatch.
    const result = compareLiveTreeToDomTree(
      [
        {
          path: "Hidden",
          type: "ColorRect",
          parentPath: null,
          visible: false,
          rect: { x: 10, y: 10, width: 50, height: 50 },
        },
      ],
      [
        {
          path: "Hidden",
          type: "ColorRect",
          parentPath: null,
          visible: false,
          rect: { x: 10, y: 10, width: 50, height: 50 },
        },
      ],
      { tolerancePx: 0.5 },
    );
    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  it("reports text run size mismatches", () => {
    const result = compareLiveTreeToDomTree(
      [
        {
          path: "Text",
          type: "RichTextLabel",
          parentPath: ".",
          rect: { x: 0, y: 0, width: 100, height: 30 },
          textRuns: [
            {
              text: "Bold",
              style: "bold",
              rect: { x: 0, y: 0, width: 54, height: 24 },
            },
          ],
        },
      ],
      [
        {
          path: "Text",
          type: "RichTextLabel",
          parentPath: ".",
          rect: { x: 0, y: 0, width: 100, height: 30 },
          textRuns: [
            {
              text: "Bold",
              style: "bold",
              rect: { x: 0, y: 0, width: 48, height: 24 },
            },
          ],
        },
      ],
      { tolerancePx: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((mismatch) => mismatch.code)).toEqual([
      "text-run-width-mismatch",
    ]);
  });

  it("reports text run position mismatches", () => {
    const result = compareLiveTreeToDomTree(
      [
        {
          path: "Text",
          type: "RichTextLabel",
          parentPath: ".",
          rect: { x: 0, y: 0, width: 100, height: 30 },
          textRuns: [
            {
              text: "Bold",
              style: "bold",
              rect: { x: 20, y: 4, width: 48, height: 24 },
            },
          ],
        },
      ],
      [
        {
          path: "Text",
          type: "RichTextLabel",
          parentPath: ".",
          rect: { x: 0, y: 0, width: 100, height: 30 },
          textRuns: [
            {
              text: "Bold",
              style: "bold",
              rect: { x: 24, y: 8, width: 48, height: 24 },
            },
          ],
        },
      ],
      { tolerancePx: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((mismatch) => mismatch.code)).toEqual([
      "text-run-x-mismatch",
      "text-run-y-mismatch",
    ]);
  });

  it("collects RichTextLabel text runs from the fill layer only", () => {
    const originalCreateRange = document.createRange.bind(document);
    let selectedNode: Node | undefined;
    document.createRange = () =>
      ({
        selectNodeContents: (node: Node) => {
          selectedNode = node;
        },
        getBoundingClientRect: () => ({
          x: 0,
          y: 0,
          width: selectedNode?.textContent?.length ?? 0,
          height: 10,
        }),
        detach: () => {},
      }) as unknown as Range;
    try {
      document.body.innerHTML = `
<div data-godot-path="Text" data-godot-name="Text" data-godot-type="RichTextLabel">
  <span class="godot-rich-stack">
    <span data-godot-rich-layer="shadow-outline" aria-hidden="true"><strong>Bold</strong></span>
    <span data-godot-rich-layer="shadow-fill" aria-hidden="true"><strong>Bold</strong></span>
    <span data-godot-rich-layer="outline" aria-hidden="true"><strong>Bold</strong></span>
    <span data-godot-rich-layer="fill"><strong>Bold</strong></span>
  </span>
</div>`;

      expect(
        collectDomTree().find((node) => node.path === "Text")?.textRuns,
      ).toEqual([
        {
          text: "Bold",
          style: "bold",
          rect: { x: 0, y: 0, width: 4, height: 10 },
        },
      ]);
    } finally {
      document.createRange = originalCreateRange;
      document.body.innerHTML = "";
    }
  });
});
