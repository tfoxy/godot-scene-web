import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeImageDiffRegion,
  loadParityFixtureMetadata,
  planGodotBatchRuns,
  resolveEffectiveParityArtifactOptions,
} from "../src/parity";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("parity fixture metadata", () => {
  it("loads sidecar screenshot and image diff options", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "godot-scene-web-parity-options-"));
    const fixture = join(tempDir, "fixture.tscn");
    await writeFile(
      join(tempDir, "fixture.parity.json"),
      JSON.stringify({
        godotScreenshot: "required",
        tolerancePx: 2,
        imageDiff: {
          enabled: true,
          mode: "text-runs",
          threshold: 0.2,
          maxDiffRatio: 0.03,
          padding: 8,
        },
      }),
    );

    await expect(loadParityFixtureMetadata(fixture)).resolves.toEqual({
      godotScreenshot: "required",
      tolerancePx: 2,
      imageDiff: {
        enabled: true,
        mode: "text-runs",
        threshold: 0.2,
        maxDiffRatio: 0.03,
        padding: 8,
      },
    });
  });

  it("loads the live-particle opt-in", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "godot-scene-web-parity-options-"));
    const fixture = join(tempDir, "fixture.tscn");
    await writeFile(
      join(tempDir, "fixture.parity.json"),
      JSON.stringify({ particles: { enabled: true } }),
    );

    await expect(loadParityFixtureMetadata(fixture)).resolves.toMatchObject({
      particles: { enabled: true },
    });
  });

  it("leaves particles unset when the sidecar omits them", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "godot-scene-web-parity-options-"));
    const fixture = join(tempDir, "fixture.tscn");
    await writeFile(
      join(tempDir, "fixture.parity.json"),
      JSON.stringify({ godotScreenshot: "required" }),
    );

    await expect(loadParityFixtureMetadata(fixture)).resolves.toEqual({
      godotScreenshot: "required",
    });
  });

  // Mounting a GPU runtime is not something a fixture gets to opt into by accident: only a literal
  // `true` counts, so a typo degrades to the default (static previews) instead of silently arming
  // the slow, GPU-dependent path.
  it.each([
    ["a truthy string", { particles: { enabled: "yes" } }],
    ["a number", { particles: { enabled: 1 } }],
    ["a bare boolean", { particles: true }],
    ["an array", { particles: [{ enabled: true }] }],
    ["null", { particles: null }],
  ])("does not enable particles from %s", async (_label, sidecar) => {
    tempDir = await mkdtemp(join(tmpdir(), "godot-scene-web-parity-options-"));
    const fixture = join(tempDir, "fixture.tscn");
    await writeFile(
      join(tempDir, "fixture.parity.json"),
      JSON.stringify(sidecar),
    );

    const metadata = await loadParityFixtureMetadata(fixture);
    expect(metadata.particles?.enabled).toBeUndefined();
    expect(
      resolveEffectiveParityArtifactOptions({}, metadata).liveParticles,
    ).toBe(false);
  });

  it("enables required Godot screenshots and image diff from metadata", () => {
    expect(
      resolveEffectiveParityArtifactOptions(
        {},
        {
          godotScreenshot: "required",
          imageDiff: {
            enabled: true,
            mode: "node",
            threshold: 0.2,
            maxDiffRatio: 0.03,
            padding: 4,
          },
        },
      ),
    ).toEqual({
      browserScreenshot: true,
      godotScreenshot: true,
      liveParticles: false,
      imageDiff: {
        mode: "node",
        threshold: 0.2,
        maxDiffRatio: 0.03,
        padding: 4,
      },
    });
  });

  it("disables Godot screenshots and image diff with no-godot-screenshot", () => {
    expect(
      resolveEffectiveParityArtifactOptions(
        { noGodotScreenshot: true },
        {
          godotScreenshot: "required",
          imageDiff: { enabled: true },
        },
      ),
    ).toEqual({
      browserScreenshot: true,
      godotScreenshot: false,
      liveParticles: false,
      imageDiff: false,
    });
  });

  it("disables image diff when browser screenshots are disabled", () => {
    expect(
      resolveEffectiveParityArtifactOptions(
        { screenshot: false, godotScreenshot: true },
        {},
      ),
    ).toEqual({
      browserScreenshot: false,
      godotScreenshot: true,
      liveParticles: false,
      imageDiff: false,
    });
  });

  it("arms the live particle runtime from the sidecar", () => {
    expect(
      resolveEffectiveParityArtifactOptions(
        {},
        {
          godotScreenshot: "required",
          particles: { enabled: true },
          imageDiff: { enabled: true },
        },
      ),
    ).toEqual({
      browserScreenshot: true,
      godotScreenshot: true,
      liveParticles: true,
      imageDiff: {
        mode: "full",
        threshold: 0.12,
        maxDiffRatio: 0.01,
        padding: 0,
      },
    });
  });

  // No screenshot, nothing for a canvas to contribute: the DOM tree is collected before the mount
  // and is unaffected by it, so the mount would be pure cost and a pure new failure mode.
  it("does not mount particles when browser screenshots are disabled", () => {
    expect(
      resolveEffectiveParityArtifactOptions(
        { screenshot: false },
        { particles: { enabled: true } },
      ).liveParticles,
    ).toBe(false);
  });

  // The Godot half is independent: `--no-godot-screenshot` turns off the image DIFF, but the
  // browser screenshot is still taken and still has to show the real runtime, or the artifact a
  // human reviews would be of preview spans.
  it("keeps particles mounted when only the Godot screenshot is disabled", () => {
    expect(
      resolveEffectiveParityArtifactOptions(
        { noGodotScreenshot: true },
        {
          godotScreenshot: "required",
          particles: { enabled: true },
          imageDiff: { enabled: true },
        },
      ),
    ).toEqual({
      browserScreenshot: true,
      godotScreenshot: false,
      liveParticles: true,
      imageDiff: false,
    });
  });
});

describe("planGodotBatchRuns", () => {
  it("runs headless fixtures before graphical fixtures", () => {
    const runs = planGodotBatchRuns([
      {
        scene: "res://fixtures/graphical.tscn",
        output: "/tmp/graphical.json",
        viewportWidth: 100,
        viewportHeight: 50,
        screenshot: "/tmp/graphical.png",
      },
      {
        scene: "res://fixtures/headless-a.tscn",
        output: "/tmp/headless-a.json",
        viewportWidth: 100,
        viewportHeight: 50,
      },
      {
        scene: "res://fixtures/headless-b.tscn",
        output: "/tmp/headless-b.json",
        viewportWidth: 200,
        viewportHeight: 80,
      },
    ]);

    expect(runs).toEqual([
      {
        headless: true,
        fixtures: [
          {
            scene: "res://fixtures/headless-a.tscn",
            output: "/tmp/headless-a.json",
            viewportWidth: 100,
            viewportHeight: 50,
          },
          {
            scene: "res://fixtures/headless-b.tscn",
            output: "/tmp/headless-b.json",
            viewportWidth: 200,
            viewportHeight: 80,
          },
        ],
      },
      {
        headless: false,
        fixtures: [
          {
            scene: "res://fixtures/graphical.tscn",
            output: "/tmp/graphical.json",
            viewportWidth: 100,
            viewportHeight: 50,
            screenshot: "/tmp/graphical.png",
          },
        ],
      },
    ]);
  });

  it("keeps single fixture runs in one matching batch", () => {
    expect(
      planGodotBatchRuns([
        {
          scene: "res://fixtures/basic.tscn",
          output: "/tmp/basic.json",
          viewportWidth: 100,
          viewportHeight: 50,
        },
      ]),
    ).toEqual([
      {
        headless: true,
        fixtures: [
          {
            scene: "res://fixtures/basic.tscn",
            output: "/tmp/basic.json",
            viewportWidth: 100,
            viewportHeight: 50,
          },
        ],
      },
    ]);

    expect(
      planGodotBatchRuns([
        {
          scene: "res://fixtures/shot.tscn",
          output: "/tmp/shot.json",
          viewportWidth: 100,
          viewportHeight: 50,
          screenshot: "/tmp/shot.png",
        },
      ]),
    ).toEqual([
      {
        headless: false,
        fixtures: [
          {
            scene: "res://fixtures/shot.tscn",
            output: "/tmp/shot.json",
            viewportWidth: 100,
            viewportHeight: 50,
            screenshot: "/tmp/shot.png",
          },
        ],
      },
    ]);
  });
});

describe("computeImageDiffRegion", () => {
  it("unions matching Godot and browser text run rects", () => {
    const region = computeImageDiffRegion(
      "text-runs",
      [
        {
          path: "Text",
          type: "RichTextLabel",
          rect: { x: 0, y: 0, width: 100, height: 40 },
          textRuns: [
            { text: "Hello", rect: { x: 10, y: 20, width: 30, height: 10 } },
          ],
        },
      ],
      [
        {
          path: "Text",
          type: "RichTextLabel",
          rect: { x: 0, y: 0, width: 100, height: 40 },
          textRuns: [
            { text: "Hello", rect: { x: 15, y: 18, width: 40, height: 9 } },
          ],
        },
      ],
      { width: 100, height: 100 },
    );

    expect(region).toEqual({ x: 10, y: 18, width: 45, height: 12 });
  });

  it("expands text run regions by padding", () => {
    const region = computeImageDiffRegion(
      "text-runs",
      [
        {
          path: "Text",
          type: "Label",
          rect: { x: 0, y: 0, width: 100, height: 40 },
          textRuns: [
            { text: "Hello", rect: { x: 10, y: 20, width: 30, height: 10 } },
          ],
        },
      ],
      [
        {
          path: "Text",
          type: "Label",
          rect: { x: 0, y: 0, width: 100, height: 40 },
          textRuns: [
            { text: "Hello", rect: { x: 15, y: 18, width: 40, height: 9 } },
          ],
        },
      ],
      { width: 100, height: 100 },
      3,
    );

    expect(region).toEqual({ x: 7, y: 15, width: 51, height: 18 });
  });

  it("clamps padded regions to image bounds", () => {
    const region = computeImageDiffRegion(
      "node",
      [
        {
          path: "Panel",
          type: "Panel",
          rect: { x: 1, y: 2, width: 10, height: 8 },
        },
      ],
      [
        {
          path: "Panel",
          type: "Panel",
          rect: { x: 80, y: 90, width: 30, height: 20 },
        },
      ],
      { width: 100, height: 100 },
      5,
    );

    expect(region).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("falls back to full-image comparison when no text runs are available", () => {
    const region = computeImageDiffRegion(
      "text-runs",
      [
        {
          path: "Panel",
          type: "Panel",
          rect: { x: 10, y: 10, width: 20, height: 20 },
        },
      ],
      [
        {
          path: "Panel",
          type: "Panel",
          rect: { x: 10, y: 10, width: 20, height: 20 },
        },
      ],
      { width: 100, height: 100 },
      8,
    );

    expect(region).toBeUndefined();
  });
});
