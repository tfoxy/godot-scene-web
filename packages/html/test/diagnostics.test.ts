import { afterEach, describe, expect, it, vi } from "vitest";

import {
  reportUnsupportedRender,
  type UnsupportedRenderInfo,
} from "@godot-scene-web/html";

// The fail-loud reporting primitive the shader + particle runtimes call when they can't render a node. Each
// case uses a distinct id so the module-level dedup set doesn't bleed across assertions.
describe("reportUnsupportedRender", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes to a supplied onUnsupported reporter", () => {
    const seen: UnsupportedRenderInfo[] = [];
    reportUnsupportedRender(
      { kind: "shader", id: "res://a.gdshader", reason: "unsupported shader construct" },
      (info) => seen.push(info),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "shader", id: "res://a.gdshader" });
  });

  it("dedups repeated (kind, id, reason) reports", () => {
    const reporter = vi.fn();
    const info = { kind: "shader", id: "res://b.gdshader", reason: "shader failed to compile" } as const;
    reportUnsupportedRender(info, reporter);
    reportUnsupportedRender(info, reporter);
    reportUnsupportedRender(info, reporter);
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it("reports distinct reasons for the same id separately", () => {
    const reporter = vi.fn();
    reportUnsupportedRender({ kind: "shader", id: "res://c.gdshader", reason: "shader source unresolved" }, reporter);
    reportUnsupportedRender({ kind: "shader", id: "res://c.gdshader", reason: "unsupported shader construct" }, reporter);
    expect(reporter).toHaveBeenCalledTimes(2);
  });

  it("falls back to a console.warn when no reporter is supplied", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportUnsupportedRender({ kind: "particle", id: "Board/Glow", reason: "malformed particle spec" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("malformed particle spec");
  });
});
