import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asRect2,
  asResourceRef,
  asString,
  type GodotExtResource,
  type GodotNode,
  type GodotResource,
  type GodotResourceRefValue,
  type GodotSceneState,
} from "@godot-scene-web/core";
import {
  type GodotHtmlModel,
  renderGodotSceneHtml,
  renderSceneToHtmlModel,
} from "@godot-scene-web/html";
import type { GodotSceneTree } from "@godot-scene-web/layout";
import {
  type GodotLayoutOptions,
  resolveGodotSceneTree as resolveSceneTreeFromGraph,
} from "@godot-scene-web/layout";
import type { SceneStructureOptions } from "@godot-scene-web/scene-graph";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import {
  parseGodotResource,
  parseGodotTextScene,
} from "@godot-scene-web/tscn-parser";
import { chromium, type Page } from "@playwright/test";
import { ensureRobotoFonts } from "../../../scripts/ensure-roboto-fonts";
import {
  comparePngScreenshots,
  type ImageDiffMode,
  type ImageDiffRegion,
  type ImageDiffResult,
} from "./image-diff";
import {
  compareLiveTreeToDomTree,
  type DomTreeNode,
  type LiveTreeNode,
  type TreeComparisonResult,
} from "./index";

// Index + derive, then run the rect cascade — the scene-taking shape the parity
// oracle used before structural indexing moved into `deriveSceneGraph`.
function resolveGodotSceneTree(
  scene: GodotSceneState,
  options?: GodotLayoutOptions & SceneStructureOptions,
): GodotSceneTree {
  return resolveSceneTreeFromGraph(deriveSceneGraph(scene, options), options);
}

const SOURCE_SCENE_PATH_ATTRIBUTE =
  "metadata/godot_scene_web/source_scene_path";

export interface RunParityFixtureOptions {
  fixturePath: string;
  artifactsDir?: string;
  tolerancePx?: number;
  screenshot?: boolean;
  godotScreenshot?: boolean;
  noGodotScreenshot?: boolean;
}

export interface ParityFixtureMetadata {
  godotScreenshot?: "required";
  tolerancePx?: number;
  /**
   * Run the LIVE particle runtime in the parity page instead of screenshotting the static `<span>`
   * previews the renderer emits by default.
   *
   * Opt-in per fixture, and deliberately narrow: mounting the runtime replaces a layout-accurate
   * stand-in with real WebGL output, which is what a blend-algebra image diff needs and what a
   * layout fixture emphatically does not want (it would trade a deterministic DOM for a GPU).
   */
  particles?: {
    enabled?: boolean;
  };
  imageDiff?: {
    enabled?: boolean;
    mode?: ImageDiffMode;
    threshold?: number;
    maxDiffRatio?: number;
    padding?: number;
  };
}

export interface EffectiveParityArtifactOptions {
  browserScreenshot: boolean;
  godotScreenshot: boolean;
  /**
   * Whether the browser page mounts the particle runtime before its screenshot.
   *
   * Gated on `browserScreenshot`: with no screenshot to take there is nothing a live canvas could
   * contribute — the DOM tree is collected before the mount and is unaffected by it — so the mount
   * would be pure cost and a pure new failure mode.
   */
  liveParticles: boolean;
  imageDiff:
    | false
    | {
        mode: ImageDiffMode;
        threshold: number;
        maxDiffRatio: number;
        padding: number;
      };
}

export interface RunParityFixtureResult {
  ok: boolean;
  fixturePath: string;
  artifactsDir: string;
  godotLiveTreePath: string;
  browserHtmlPath: string;
  browserDomTreePath: string;
  comparisonPath: string;
  screenshotPath?: string;
  godotScreenshotPath?: string;
  comparison: TreeComparisonResult;
}

interface PreparedParityFixture {
  fixturePath: string;
  artifactsDir: string;
  metadata: ParityFixtureMetadata;
  effectiveOptions: EffectiveParityArtifactOptions;
  godotLiveTreePath: string;
  browserHtmlPath: string;
  browserDomTreePath: string;
  comparisonPath: string;
  screenshotPath: string;
  godotScreenshotPath: string;
  imageDiffPath: string;
  browserScreenshotCaptured: boolean;
  browserScreenshotError?: string;
  browserTree: {
    nodes: DomTreeNode[];
    viewport: { width: number; height: number };
  };
  tolerancePx?: number;
}

export interface GodotBatchManifestFixture {
  scene: string;
  output: string;
  viewportWidth: number;
  viewportHeight: number;
  screenshot?: string;
}

export interface GodotBatchRun {
  headless: boolean;
  fixtures: GodotBatchManifestFixture[];
}

export async function runParityFixture(
  options: RunParityFixtureOptions,
): Promise<RunParityFixtureResult> {
  const [result] = await runParityFixtures([options]);
  if (!result) {
    throw new Error("runParityFixture did not produce a result.");
  }
  return result;
}

export async function runParityFixtures(
  options: RunParityFixtureOptions[],
): Promise<RunParityFixtureResult[]> {
  if (options.length === 0) {
    return [];
  }
  const repoRoot = findRepoRoot();
  await ensureRobotoFonts(repoRoot);
  const preparedFixtures: PreparedParityFixture[] = [];
  for (const option of options) {
    preparedFixtures.push(await prepareParityFixture(repoRoot, option));
  }

  await inspectPreparedFixturesWithGodot(repoRoot, preparedFixtures);

  const results: RunParityFixtureResult[] = [];
  for (const prepared of preparedFixtures) {
    results.push(await comparePreparedParityFixture(prepared));
  }
  return results;
}

async function prepareParityFixture(
  repoRoot: string,
  options: RunParityFixtureOptions,
): Promise<PreparedParityFixture> {
  const fixturePath = resolve(repoRoot, options.fixturePath);
  const artifactsDir = resolve(
    repoRoot,
    options.artifactsDir ??
      join("artifacts", "parity", parityArtifactName(repoRoot, fixturePath)),
  );
  const metadata = await loadParityFixtureMetadata(fixturePath);
  const effectiveOptions = resolveEffectiveParityArtifactOptions(
    options,
    metadata,
  );
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  const godotLiveTreePath = join(artifactsDir, "godot-live-tree.json");
  const browserHtmlPath = join(artifactsDir, "browser.html");
  const browserDomTreePath = join(artifactsDir, "browser-dom-tree.json");
  const comparisonPath = join(artifactsDir, "comparison.json");
  const screenshotPath = join(artifactsDir, "browser.png");
  const godotScreenshotPath = join(artifactsDir, "godot.png");
  const imageDiffPath = join(artifactsDir, "image-diff.png");

  const browserTree = await inspectFixtureWithBrowser(
    fixturePath,
    browserHtmlPath,
    browserDomTreePath,
    effectiveOptions.browserScreenshot ? screenshotPath : undefined,
    effectiveOptions.liveParticles,
  );

  return {
    fixturePath,
    artifactsDir,
    metadata,
    effectiveOptions,
    godotLiveTreePath,
    browserHtmlPath,
    browserDomTreePath,
    comparisonPath,
    screenshotPath,
    browserScreenshotCaptured: browserTree.screenshotCaptured,
    browserScreenshotError: browserTree.screenshotError,
    godotScreenshotPath,
    imageDiffPath,
    browserTree,
    tolerancePx: options.tolerancePx,
  };
}

async function comparePreparedParityFixture(
  prepared: PreparedParityFixture,
): Promise<RunParityFixtureResult> {
  const godotTree = JSON.parse(
    await readFile(prepared.godotLiveTreePath, "utf8"),
  ) as GodotSceneTree;
  const tolerancePx =
    prepared.tolerancePx ?? prepared.metadata.tolerancePx ?? 1;
  const treeComparison = compareLiveTreeToDomTree(
    godotTree.nodes,
    prepared.browserTree.nodes,
    {
      tolerancePx,
      compareType: true,
      compareParent: true,
      compareVisibility: true,
      // The renderer prunes effectively-hidden subtrees to comments, so hidden
      // live nodes must be ABSENT from the DOM. The layout-tree comparison below
      // keeps the default and still validates hidden nodes' computed rects.
      hiddenLiveNodes: "expect-absent",
    },
  );
  const layoutTreeComparison = shouldCompareLayoutTreeToGodotTree(
    prepared.fixturePath,
  )
    ? compareLayoutTreeToGodotTree(prepared.fixturePath, godotTree, tolerancePx)
    : undefined;
  const imageDiffOptions = prepared.effectiveOptions.imageDiff;
  const imageDiffRegion = imageDiffOptions
    ? computeImageDiffRegion(
        imageDiffOptions.mode,
        godotTree.nodes,
        prepared.browserTree.nodes,
        prepared.browserTree.viewport,
        imageDiffOptions.padding,
      )
    : undefined;
  const shouldCompareImageDiff =
    imageDiffOptions && prepared.browserScreenshotCaptured;

  const imageDiff = shouldCompareImageDiff
    ? await comparePngScreenshots(
        prepared.godotScreenshotPath,
        prepared.screenshotPath,
        {
          mode: imageDiffOptions.mode,
          threshold: imageDiffOptions.threshold,
          maxDiffRatio: imageDiffOptions.maxDiffRatio,
          diffPath: prepared.imageDiffPath,
          region: imageDiffRegion,
        },
      )
    : undefined;
  const comparison = mergeComparisonWithImageDiff(
    mergeTreeComparisons(treeComparison, layoutTreeComparison),
    imageDiff,
  );
  await writeFile(
    prepared.comparisonPath,
    `${JSON.stringify(comparison, null, 2)}\n`,
    "utf8",
  );
  return {
    ok: comparison.ok,
    fixturePath: prepared.fixturePath,
    artifactsDir: prepared.artifactsDir,
    godotLiveTreePath: prepared.godotLiveTreePath,
    browserHtmlPath: prepared.browserHtmlPath,
    browserDomTreePath: prepared.browserDomTreePath,
    comparisonPath: prepared.comparisonPath,
    screenshotPath: prepared.effectiveOptions.browserScreenshot
      ? prepared.browserScreenshotCaptured
        ? prepared.screenshotPath
        : undefined
      : undefined,
    godotScreenshotPath: prepared.effectiveOptions.godotScreenshot
      ? prepared.godotScreenshotPath
      : undefined,
    comparison,
  };
}

export async function loadParityFixtureMetadata(
  fixturePath: string,
): Promise<ParityFixtureMetadata> {
  try {
    const source = await readFile(parityMetadataPath(fixturePath), "utf8");
    return normalizeParityFixtureMetadata(JSON.parse(source));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

export function resolveEffectiveParityArtifactOptions(
  options: Pick<
    RunParityFixtureOptions,
    "screenshot" | "godotScreenshot" | "noGodotScreenshot"
  >,
  metadata: ParityFixtureMetadata = {},
): EffectiveParityArtifactOptions {
  const browserScreenshot = options.screenshot !== false;
  const godotScreenshot =
    !options.noGodotScreenshot &&
    (options.godotScreenshot === true ||
      metadata.godotScreenshot === "required");
  const imageDiffEnabled =
    browserScreenshot &&
    godotScreenshot &&
    (options.godotScreenshot === true || metadata.imageDiff?.enabled === true);
  return {
    browserScreenshot,
    godotScreenshot,
    liveParticles: browserScreenshot && metadata.particles?.enabled === true,
    imageDiff: imageDiffEnabled
      ? {
          mode: metadata.imageDiff?.mode ?? "full",
          threshold: metadata.imageDiff?.threshold ?? 0.12,
          maxDiffRatio: metadata.imageDiff?.maxDiffRatio ?? 0.01,
          padding: metadata.imageDiff?.padding ?? 0,
        }
      : false,
  };
}

function parityMetadataPath(fixturePath: string): string {
  return `${fixturePath.slice(0, -extname(fixturePath).length)}.parity.json`;
}

function normalizeParityFixtureMetadata(value: unknown): ParityFixtureMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const imageDiff =
    record.imageDiff &&
    typeof record.imageDiff === "object" &&
    !Array.isArray(record.imageDiff)
      ? (record.imageDiff as Record<string, unknown>)
      : undefined;
  const particles =
    record.particles &&
    typeof record.particles === "object" &&
    !Array.isArray(record.particles)
      ? (record.particles as Record<string, unknown>)
      : undefined;
  return {
    godotScreenshot:
      record.godotScreenshot === "required" ? "required" : undefined,
    tolerancePx:
      typeof record.tolerancePx === "number" ? record.tolerancePx : undefined,
    // Strictly `true`, never truthy: mounting a GPU runtime is not something a fixture should be
    // able to opt into by writing `"yes"`.
    particles: particles
      ? { enabled: particles.enabled === true ? true : undefined }
      : undefined,
    imageDiff: imageDiff
      ? {
          enabled:
            typeof imageDiff.enabled === "boolean"
              ? imageDiff.enabled
              : undefined,
          mode:
            imageDiff.mode === "node" ||
            imageDiff.mode === "text-runs" ||
            imageDiff.mode === "full"
              ? imageDiff.mode
              : undefined,
          threshold:
            typeof imageDiff.threshold === "number"
              ? imageDiff.threshold
              : undefined,
          maxDiffRatio:
            typeof imageDiff.maxDiffRatio === "number"
              ? imageDiff.maxDiffRatio
              : undefined,
          padding:
            typeof imageDiff.padding === "number"
              ? imageDiff.padding
              : undefined,
        }
      : undefined,
  };
}

export function computeImageDiffRegion(
  mode: ImageDiffMode,
  liveNodes: LiveTreeNode[],
  domNodes: DomTreeNode[],
  imageBounds: { width: number; height: number },
  padding = 0,
): ImageDiffRegion | undefined {
  if (mode === "full") {
    return undefined;
  }

  const domByPath = new Map(domNodes.map((node) => [node.path, node]));
  const rects: ImageDiffRegion[] = [];
  for (const live of liveNodes) {
    const dom = domByPath.get(live.path);
    if (!dom) {
      continue;
    }
    if (mode === "text-runs") {
      const liveRuns = live.textRuns ?? [];
      const domRuns = dom.textRuns ?? [];
      const runCount = Math.min(liveRuns.length, domRuns.length);
      for (let index = 0; index < runCount; index += 1) {
        const liveRun = liveRuns[index];
        const domRun = domRuns[index];
        if (liveRun && domRun) {
          rects.push(liveRun.rect, domRun.rect);
        }
      }
    } else if (hasVisualNodeContent(live) || hasVisualNodeContent(dom)) {
      rects.push(live.rect, dom.rect);
    }
  }

  return paddedClampedUnion(rects, padding, imageBounds);
}

function paddedClampedUnion(
  rects: ImageDiffRegion[],
  padding: number,
  imageBounds: { width: number; height: number },
): ImageDiffRegion | undefined {
  const nonEmptyRects = rects.filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  if (nonEmptyRects.length === 0) {
    return undefined;
  }

  const minX = Math.min(...nonEmptyRects.map((rect) => rect.x)) - padding;
  const minY = Math.min(...nonEmptyRects.map((rect) => rect.y)) - padding;
  const maxX =
    Math.max(...nonEmptyRects.map((rect) => rect.x + rect.width)) + padding;
  const maxY =
    Math.max(...nonEmptyRects.map((rect) => rect.y + rect.height)) + padding;
  const x = Math.max(0, Math.floor(minX));
  const y = Math.max(0, Math.floor(minY));
  const right = Math.min(imageBounds.width, Math.ceil(maxX));
  const bottom = Math.min(imageBounds.height, Math.ceil(maxY));
  if (right <= x || bottom <= y) {
    return undefined;
  }
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

function hasVisualNodeContent(node: LiveTreeNode | DomTreeNode): boolean {
  if ((node.textRuns?.length ?? 0) > 0) {
    return true;
  }
  return (
    node.type === "AnimatedSprite2D" ||
    node.type === "Button" ||
    node.type === "ColorRect" ||
    node.type === "CPUParticles2D" ||
    node.type === "GPUParticles2D" ||
    node.type === "Label" ||
    node.type === "Line2D" ||
    node.type === "NinePatchRect" ||
    node.type === "Panel" ||
    node.type === "RichTextLabel" ||
    node.type === "Sprite2D" ||
    node.type === "TextureRect"
  );
}

function mergeComparisonWithImageDiff(
  treeComparison: TreeComparisonResult,
  imageDiff: ImageDiffResult | undefined,
): TreeComparisonResult {
  const mismatches = [...treeComparison.mismatches];
  if (imageDiff && !imageDiff.ok) {
    mismatches.push({
      code: "screenshot-diff-mismatch",
      path: ".",
      message:
        imageDiff.reason === "dimension-mismatch"
          ? "Godot and browser screenshots have different dimensions."
          : "Godot and browser screenshots differ by more than the configured image threshold.",
      expected:
        imageDiff.reason === "dimension-mismatch"
          ? imageDiff.expectedSize
          : { maxDiffRatio: imageDiff.maxDiffRatio },
      actual:
        imageDiff.reason === "dimension-mismatch"
          ? imageDiff.actualSize
          : {
              diffRatio: imageDiff.diffRatio,
              diffPixels: imageDiff.diffPixels,
              totalPixels: imageDiff.totalPixels,
            },
    });
  }
  return {
    ok: mismatches.length === 0,
    mismatches,
    imageDiff,
  };
}

function mergeTreeComparisons(
  domComparison: TreeComparisonResult,
  layoutComparison: TreeComparisonResult | undefined,
): TreeComparisonResult {
  if (!layoutComparison) {
    return domComparison;
  }
  return {
    ok: domComparison.ok && layoutComparison.ok,
    mismatches: [
      ...domComparison.mismatches,
      ...layoutComparison.mismatches.map((mismatch) => ({
        ...mismatch,
        code: `layout-tree-${mismatch.code}`,
        message: `Layout-produced GodotSceneTree differs from Godot-produced tree: ${mismatch.message}`,
      })),
    ],
  };
}

function shouldCompareLayoutTreeToGodotTree(fixturePath: string): boolean {
  const normalized = fixturePath.split(sep).join("/");
  return (
    normalized.includes("/anchors/") ||
    normalized.includes("/offsets/") ||
    normalized.includes("/containers/") ||
    normalized.includes("/visibility/")
  );
}

function compareLayoutTreeToGodotTree(
  fixturePath: string,
  godotTree: GodotSceneTree,
  tolerancePx: number,
): TreeComparisonResult {
  const repoRoot = findRepoRoot();
  const scene = parseGodotTextScene(readFileSync(fixturePath, "utf8"), {
    path: fixturePath,
  });
  tagSceneNodes(scene, resolveGodotFixturePath(repoRoot, fixturePath));
  const layoutTree = resolveGodotSceneTree(scene, {
    mountExternalScene: (ref, node) => {
      const sourceScene = sceneForNode(repoRoot, scene, node) ?? scene;
      const resource = extResource(sourceScene, ref);
      return resource?.path?.endsWith(".tscn")
        ? parseGodotSceneResource(repoRoot, resource.path)
        : undefined;
    },
    resolveResource: (ref, node) =>
      resolveFixtureResource(repoRoot, scene, ref, node),
  });
  return compareLiveTreeToDomTree(godotTree.nodes, layoutTree.nodes, {
    tolerancePx,
    compareType: true,
    compareParent: true,
    compareVisibility: true,
  });
}

async function inspectPreparedFixturesWithGodot(
  repoRoot: string,
  fixtures: PreparedParityFixture[],
): Promise<void> {
  const batchRuns = planGodotBatchRuns(
    fixtures.map((fixture) => ({
      scene: resolveGodotFixturePath(repoRoot, fixture.fixturePath),
      output: fixture.godotLiveTreePath,
      viewportWidth: fixture.browserTree.viewport.width,
      viewportHeight: fixture.browserTree.viewport.height,
      screenshot: fixture.effectiveOptions.godotScreenshot
        ? fixture.godotScreenshotPath
        : undefined,
    })),
  );
  if (batchRuns.length === 0) {
    return;
  }

  const projectRoot = join(repoRoot, "godot", "project");
  if (batchRuns.some((run) => !run.headless)) {
    await runCommand(
      "godot",
      ["--headless", "--path", projectRoot, "--import"],
      repoRoot,
    );
  }
  const tempDir = await mkdtemp(
    join(tmpdir(), "godot-scene-web-parity-batch-"),
  );
  try {
    for (let index = 0; index < batchRuns.length; index += 1) {
      const batchRun = batchRuns[index];
      const manifestPath = join(tempDir, `manifest-${index}.json`);
      await writeFile(
        manifestPath,
        `${JSON.stringify({ fixtures: batchRun.fixtures }, null, 2)}\n`,
        "utf8",
      );
      const args = [
        "--path",
        projectRoot,
        "--script",
        "res://scripts/inspect_scene.gd",
        "--",
        "--batch",
        manifestPath,
      ];
      if (batchRun.headless) {
        args.unshift("--headless");
      }
      await runCommand("godot", args, repoRoot);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function planGodotBatchRuns(
  fixtures: GodotBatchManifestFixture[],
): GodotBatchRun[] {
  const headlessFixtures = fixtures.filter((fixture) => !fixture.screenshot);
  const graphicalFixtures = fixtures.filter((fixture) =>
    Boolean(fixture.screenshot),
  );
  return [
    headlessFixtures.length > 0
      ? { headless: true, fixtures: headlessFixtures }
      : undefined,
    graphicalFixtures.length > 0
      ? { headless: false, fixtures: graphicalFixtures }
      : undefined,
  ].filter((run): run is GodotBatchRun => Boolean(run));
}

function resolveGodotFixturePath(
  repoRoot: string,
  fixturePath: string,
): string {
  const fixturesRoot = join(repoRoot, "fixtures");
  const fixtureRelativePath = relative(fixturesRoot, fixturePath);
  if (
    fixtureRelativePath &&
    !fixtureRelativePath.startsWith("..") &&
    !fixtureRelativePath.startsWith(sep)
  ) {
    return `res://fixtures/${toResourcePath(fixtureRelativePath)}`;
  }

  throw new Error(
    `Parity fixtures must be under ${fixturesRoot}: ${fixturePath}`,
  );
}

function toResourcePath(path: string): string {
  return path.split(sep).join("/");
}

async function inspectFixtureWithBrowser(
  fixturePath: string,
  htmlPath: string,
  outputPath: string,
  screenshotPath?: string,
  liveParticles = false,
): Promise<{
  nodes: DomTreeNode[];
  viewport: { width: number; height: number };
  screenshotCaptured: boolean;
  screenshotError?: string;
}> {
  const repoRoot = findRepoRoot();
  const source = await readFile(fixturePath, "utf8");
  const scene = parseGodotTextScene(source, { path: fixturePath });
  tagSceneNodes(scene, resolveGodotFixturePath(repoRoot, fixturePath));
  const resolveResource = (ref: GodotResourceRefValue, node: GodotNode) =>
    resolveFixtureResource(repoRoot, scene, ref, node);
  const tree = resolveGodotSceneTree(scene, {
    mountExternalScene: (ref, node) => {
      const sourceScene = sceneForNode(repoRoot, scene, node) ?? scene;
      const resource = extResource(sourceScene, ref);
      return resource?.path?.endsWith(".tscn")
        ? parseGodotSceneResource(repoRoot, resource.path)
        : undefined;
    },
    resolveResource,
  });
  const model = renderSceneToHtmlModel(tree, {
    resolveResource,
    // The renderer only stamps `data-godot-particle-runtime` + the spec blob when particles are
    // enabled AND the node matches `particleIds`; without both it emits the static `<span>` preview
    // and there is nothing for the runtime to mount over. `"*"` because a fixture's process material
    // is usually an inline sub-resource with no stable id to name.
    ...(liveParticles
      ? { enableParticles: true, particleIds: ["*"] }
      : undefined),
  });
  const viewport = contentViewport(model);
  const html = renderGodotSceneHtml(model, { viewport });
  await writeFile(htmlPath, html, "utf8");
  const browser = await chromium.launch();
  let screenshotCaptured = false;
  let screenshotError: string | undefined;
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    // `setContent(..., load)` only waits for document resources. A font face can
    // still be loading when Range geometry is read, which records the fallback
    // font's advances and makes text parity nondeterministic. The default face
    // is intentionally embedded, while explicit FontFile/FontVariation faces
    // may be external; `document.fonts.ready` covers both before every range
    // measurement and the optional screenshot below.
    await page.evaluate(async () => {
      await document.fonts?.ready;
    });
    const nodes = await page.evaluate<DomTreeNode[]>(`(() => {
      const collectTextRuns = (element) => {
        if (element.dataset.godotType !== "Label" && element.dataset.godotType !== "RichTextLabel") {
          return undefined;
        }
        const textRoot = element.dataset.godotType === "RichTextLabel"
          ? element.querySelector('[data-godot-rich-layer="fill"]') ?? element
          : element;
        const runs = [];
        const collect = (node, style) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent ?? "";
            if (!text) {
              return;
            }
            const range = document.createRange();
            range.selectNodeContents(node);
            const rect = range.getBoundingClientRect();
            range.detach();
            runs.push({
              text,
              style,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            });
            return;
          }
          if (node instanceof HTMLElement) {
            const nodeStyle = node.tagName === "STRONG"
              ? "bold"
              : node.tagName === "EM"
                ? "italic"
                : style;
            for (const child of node.childNodes) {
              collect(child, nodeStyle);
            }
          }
        };
        for (const child of textRoot.childNodes) {
          collect(child, "");
        }
        return runs.length > 0 ? runs : undefined;
      };
      return [...document.querySelectorAll("[data-godot-path]")].map((element) => {
        const rect = element.getBoundingClientRect();
        const parent = element.parentElement?.closest("[data-godot-path]");
        return {
          path: element.dataset.godotPath ?? "",
          name: element.dataset.godotName,
          type: element.dataset.godotType,
          parentPath: parent?.dataset.godotPath ?? null,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          textRuns: collectTextRuns(element)
        };
      });
    })()`);
    await writeFile(
      outputPath,
      `${JSON.stringify({ nodes }, null, 2)}\n`,
      "utf8",
    );
    // AFTER the DOM tree (the mount must not be able to perturb the geometry the tree comparison
    // reads) and BEFORE the screenshot (the canvases have to be on the page when it is taken).
    if (liveParticles) {
      await mountLiveParticles(page, fixturePath);
    }
    if (screenshotPath) {
      for (const options of [{}, { fullPage: true }]) {
        try {
          await page.screenshot({
            path: screenshotPath,
            animations: "disabled",
            ...options,
          });
          screenshotCaptured = true;
          break;
        } catch (error) {
          screenshotError =
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
        }
      }
      if (!screenshotCaptured && screenshotError) {
        console.warn(
          `[parity] unable to capture browser screenshot for ${fixturePath}: ${screenshotError}`,
        );
      }
    }
    return {
      nodes,
      viewport,
      screenshotCaptured,
      screenshotError: screenshotError,
    };
  } finally {
    await browser.close();
  }
}

/**
 * How long the injected bundle has to define its hook. Generous: it is one `addScriptTag` of
 * already-built text, so anything approaching this is a bundle that failed to evaluate, not a slow
 * one — and the page-error trail collected below is what says which.
 */
const PARTICLE_HOOK_TIMEOUT_MS = 15000;

/**
 * Bundled once per process and reused across fixtures: the bundle does not depend on the fixture,
 * and esbuild is by far the slowest step in this file. `import("esbuild")` is dynamic so that the
 * dependency is only paid for by runs that actually mount particles.
 */
let particleParityBundle: Promise<string> | undefined;

function particleParityBundleText(): Promise<string> {
  particleParityBundle ??= (async () => {
    const esbuild = await import("esbuild");
    const packageRoot = join(findRepoRoot(), "packages", "test-harness");
    const result = await esbuild.build({
      entryPoints: [
        join(packageRoot, "src", "particles-parity", "browser-entry.ts"),
      ],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["chrome110"],
      // What makes `@godot-scene-web/html` resolve to its TypeScript SOURCE: the harness must mount
      // the shipped code, not a `dist/` that may be stale or absent.
      conditions: ["development"],
      write: false,
      sourcemap: "inline",
      absWorkingDir: packageRoot,
      logLevel: "silent",
    });
    const file = result.outputFiles?.[0];
    if (!file) {
      throw new Error(
        "esbuild produced no output for the particles-parity browser entry",
      );
    }
    return file.text;
  })();
  return particleParityBundle;
}

/**
 * Replace the page's static particle previews with the LIVE runtime's canvases, and throw if that
 * did not fully happen.
 *
 * Throwing is the whole contract. `comparePreparedParityFixture` SKIPS the image diff when the
 * browser screenshot is missing, and a screenshot of unmounted preview spans would be compared
 * against Godot's real particles and "calibrated" into whatever budget made it pass. So every way
 * this can go wrong — bundle that will not evaluate, runtime that declines the software renderer,
 * a node that never drew — has to abort the fixture rather than degrade it.
 */
async function mountLiveParticles(
  page: Page,
  fixturePath: string,
): Promise<void> {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const trail = () =>
    pageErrors.length > 0 ? ` Page errors: ${pageErrors.join(" | ")}` : "";

  await page.addScriptTag({
    content: await particleParityBundleText(),
    type: "module",
  });
  try {
    await page.waitForFunction(
      () => "__gswParticleParity" in window,
      undefined,
      {
        timeout: PARTICLE_HOOK_TIMEOUT_MS,
      },
    );
  } catch (error) {
    throw new Error(
      `[parity] the particle mount bundle never defined window.__gswParticleParity for ${fixturePath}: ${error instanceof Error ? error.message : String(error)}.${trail()}`,
    );
  }

  const mounted = await page.evaluate(() =>
    (
      window as unknown as {
        __gswParticleParity: {
          mountAll(): Promise<{
            expected: number;
            rendered: number;
            renderer: string;
            draws: number;
            cacheHits: number;
          }>;
        };
      }
    ).__gswParticleParity.mountAll(),
  );
  if (mounted.rendered !== mounted.expected) {
    throw new Error(
      `[parity] only ${mounted.rendered}/${mounted.expected} particle nodes rendered for ${fixturePath} (renderer="${mounted.renderer}", draws=${mounted.draws}, cacheHits=${mounted.cacheHits}).${trail()}`,
    );
  }
}

function contentViewport(model: GodotHtmlModel): {
  width: number;
  height: number;
} {
  const nodeByPath = new Map(model.nodes.map((node) => [node.path, node]));
  const roots = model.nodes.filter((node) => node.parentPath === null);
  let width = 1;
  let height = 1;
  const visit = (
    node: GodotHtmlModel["nodes"][number],
    parentX: number,
    parentY: number,
  ): void => {
    const left = parentX + cssPx(node.style.left);
    const top = parentY + cssPx(node.style.top);
    width = Math.max(width, Math.ceil(left + cssPx(node.style.width)));
    height = Math.max(height, Math.ceil(top + cssPx(node.style.height)));
    for (const childPath of node.children) {
      const child = nodeByPath.get(childPath);
      if (child) {
        visit(child, left, top);
      }
    }
  };
  for (const root of roots) {
    visit(root, 0, 0);
  }
  return { width, height };
}

function cssPx(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveFixtureResource(
  repoRoot: string,
  scene: GodotSceneState,
  ref: GodotResourceRefValue,
  node: GodotNode,
): unknown {
  const sourceScene = sceneForNode(repoRoot, scene, node) ?? scene;
  if (ref.type === "SubResource") {
    const resource = sourceScene.subResources.find(
      (candidate) => candidate.id === ref.id,
    );
    return resource
      ? { type: resource.type, document: subResourceDocument(resource) }
      : undefined;
  }
  const resource = extResource(sourceScene, ref);
  if (!resource?.path) {
    return undefined;
  }
  if (resource.path.endsWith(".tres")) {
    const document = loadFixtureResource(repoRoot, resource.path);
    if (document.header?.attributes.type === "FontVariation") {
      return fontVariationFixtureResource(repoRoot, resource.path, document);
    }
    if (document.header?.attributes.type === "FontFile") {
      return fontFixtureResource(repoRoot, resource.path);
    }
    if (document.header?.attributes.type === "AtlasTexture") {
      return atlasTextureFixtureResource(repoRoot, resource.path, document);
    }
    return {
      path: resource.path,
      document,
    };
  }
  if (isFontPath(resource.path)) {
    return fontFileFixtureResource(repoRoot, resource.path);
  }
  if (isImagePath(resource.path)) {
    return imageFileFixtureResource(repoRoot, resource.path);
  }
  return {
    path: resource.path,
    url: resource.path.replace(/^res:\/\//, "/"),
  };
}

function sceneForNode(
  repoRoot: string,
  rootScene: GodotSceneState,
  node: GodotNode,
): GodotSceneState | undefined {
  const sourcePath = asString(node.properties[SOURCE_SCENE_PATH_ATTRIBUTE]);
  return sourcePath ? parseGodotSceneResource(repoRoot, sourcePath) : rootScene;
}

function tagSceneNodes(scene: GodotSceneState, resourcePath: string): void {
  for (const node of scene.nodes) {
    const existing = node.properties.find(
      (property) => property.name === SOURCE_SCENE_PATH_ATTRIBUTE,
    );
    if (existing) {
      existing.value = resourcePath;
    } else {
      node.properties.push({
        name: SOURCE_SCENE_PATH_ATTRIBUTE,
        value: resourcePath,
      });
    }
  }
}

function subResourceDocument(resource: {
  type?: string;
  properties: Record<string, unknown>;
}): GodotResource {
  return {
    type: resource.type,
    header: resource.type
      ? { section: "gd_resource", attributes: { type: resource.type } }
      : null,
    extResources: [],
    subResources: [],
    properties: resource.properties as GodotResource["properties"],
    diagnostics: [],
  };
}

function fontVariationFixtureResource(
  repoRoot: string,
  resourcePath: string,
  document: ReturnType<typeof loadFixtureResource>,
): unknown {
  const baseRef = asResourceRef(document.properties.base_font);
  if (baseRef?.type !== "ExtResource") {
    return { path: resourcePath, document };
  }
  const base = document.extResources.find(
    (candidate) => candidate.id === baseRef.id,
  );
  if (!base?.path) {
    return { path: resourcePath, document };
  }
  const baseResource = fontFixtureResource(repoRoot, base.path);
  if (!baseResource) {
    return { path: resourcePath, document };
  }
  return {
    ...baseResource,
    path: resourcePath,
    document,
    fontWeight:
      fontWeightFromVariationDocument(document) ??
      fontWeightFromPath(resourcePath),
    fontStyle: baseResource.fontStyle ?? fontStyleFromPath(base.path),
  };
}

function fontFixtureResource(repoRoot: string, resourcePath: string) {
  if (isFontPath(resourcePath)) {
    return fontFileFixtureResource(repoRoot, resourcePath);
  }
  if (!resourcePath.endsWith(".tres")) {
    return undefined;
  }
  const document = loadFixtureResource(repoRoot, resourcePath);
  if (document.header?.attributes.type !== "FontFile") {
    return undefined;
  }
  const fontPath =
    typeof document.properties.font_path === "string"
      ? document.properties.font_path
      : undefined;
  if (!fontPath || !isFontPath(fontPath)) {
    return undefined;
  }
  return {
    ...fontFileFixtureResource(repoRoot, fontPath),
    path: resourcePath,
    document,
  };
}

function fontFileFixtureResource(repoRoot: string, resourcePath: string) {
  const url = fontDataUrl(repoRoot, resourcePath);
  return {
    path: resourcePath,
    url,
    fontUrl: url,
    fontFamily: fontFamilyFromPath(resourcePath),
    fontStyle: fontStyleFromPath(resourcePath),
    fontWeight: fontWeightFromPath(resourcePath),
  };
}

function atlasTextureFixtureResource(
  repoRoot: string,
  resourcePath: string,
  document: ReturnType<typeof loadFixtureResource>,
): unknown {
  const atlasRef = asResourceRef(document.properties.atlas);
  const atlas = atlasRef
    ? document.extResources.find((candidate) => candidate.id === atlasRef.id)
    : undefined;
  const region = asRect2(document.properties.region);
  const atlasResource = atlas?.path
    ? resolvePathFixtureResource(repoRoot, atlas.path, atlas.type)
    : undefined;
  return {
    path: resourcePath,
    document,
    atlas: atlasResource,
    size: region
      ? { width: region.width, height: region.height }
      : resourceSize(atlasResource),
  };
}

function resolvePathFixtureResource(
  repoRoot: string,
  resourcePath: string,
  type?: string,
): unknown {
  if (resourcePath.endsWith(".tres")) {
    const document = loadFixtureResource(repoRoot, resourcePath);
    if (document.header?.attributes.type === "FontVariation") {
      return fontVariationFixtureResource(repoRoot, resourcePath, document);
    }
    if (document.header?.attributes.type === "FontFile") {
      return fontFixtureResource(repoRoot, resourcePath);
    }
    if (document.header?.attributes.type === "AtlasTexture") {
      return atlasTextureFixtureResource(repoRoot, resourcePath, document);
    }
    return {
      type: asString(document.header?.attributes.type) ?? type,
      path: resourcePath,
      document,
    };
  }
  if (isFontPath(resourcePath)) {
    return fontFileFixtureResource(repoRoot, resourcePath);
  }
  if (isImagePath(resourcePath)) {
    return imageFileFixtureResource(repoRoot, resourcePath, type);
  }
  return {
    type,
    path: resourcePath,
    url: resourcePath.replace(/^res:\/\//, "/"),
  };
}

function imageFileFixtureResource(
  repoRoot: string,
  resourcePath: string,
  type?: string,
) {
  return {
    type,
    path: resourcePath,
    url: imageDataUrl(repoRoot, resourcePath),
    size: imageSize(repoRoot, resourcePath),
  };
}

function fontDataUrl(repoRoot: string, resourcePath: string): string {
  const filePath = resolveResourceFilePath(repoRoot, resourcePath);
  const content = readFileSync(filePath);
  return `data:${fontMimeType(resourcePath)};base64,${content.toString("base64")}`;
}

function imageDataUrl(repoRoot: string, resourcePath: string): string {
  const filePath = resolveResourceFilePath(repoRoot, resourcePath);
  const content = readFileSync(filePath);
  return `data:${imageMimeType(resourcePath)};base64,${content.toString("base64")}`;
}

function fontMimeType(path: string): string {
  if (/\.otf$/i.test(path)) {
    return "font/otf";
  }
  if (/\.woff2$/i.test(path)) {
    return "font/woff2";
  }
  if (/\.woff$/i.test(path)) {
    return "font/woff";
  }
  return "font/ttf";
}

function isFontPath(path: string): boolean {
  return /\.(?:ttf|otf|woff2?|ttc)$/i.test(path);
}

function isImagePath(path: string): boolean {
  return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(path);
}

function imageMimeType(path: string): string {
  if (/\.avif$/i.test(path)) {
    return "image/avif";
  }
  if (/\.bmp$/i.test(path)) {
    return "image/bmp";
  }
  if (/\.gif$/i.test(path)) {
    return "image/gif";
  }
  if (/\.jpe?g$/i.test(path)) {
    return "image/jpeg";
  }
  if (/\.png$/i.test(path)) {
    return "image/png";
  }
  if (/\.webp$/i.test(path)) {
    return "image/webp";
  }
  return "image/svg+xml";
}

function imageSize(
  repoRoot: string,
  resourcePath: string,
): { width: number; height: number } | undefined {
  const filePath = resolveResourceFilePath(repoRoot, resourcePath);
  const content = readFileSync(filePath);
  if (/\.svg$/i.test(resourcePath)) {
    return svgImageSize(content.toString("utf8"));
  }
  if (
    /\.png$/i.test(resourcePath) &&
    content.length >= 24 &&
    content.toString("ascii", 1, 4) === "PNG"
  ) {
    return {
      width: content.readUInt32BE(16),
      height: content.readUInt32BE(20),
    };
  }
  return undefined;
}

function svgImageSize(
  source: string,
): { width: number; height: number } | undefined {
  const svg = source.match(/<svg\b[^>]*>/i)?.[0];
  if (!svg) {
    return undefined;
  }
  const width = svgNumberAttribute(svg, "width");
  const height = svgNumberAttribute(svg, "height");
  if (width !== undefined && height !== undefined) {
    return { width, height };
  }
  const viewBox = svg
    .match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    return { width: viewBox[2] ?? 0, height: viewBox[3] ?? 0 };
  }
  return undefined;
}

function svgNumberAttribute(svg: string, name: string): number | undefined {
  const value = svg.match(
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"),
  )?.[1];
  if (!value) {
    return undefined;
  }
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
}

function resourceSize(
  resource: unknown,
): { width: number; height: number } | undefined {
  if (!resource || typeof resource !== "object") {
    return undefined;
  }
  const size = (resource as { size?: unknown }).size;
  if (!size || typeof size !== "object" || Array.isArray(size)) {
    return undefined;
  }
  const record = size as Record<string, unknown>;
  const width = typeof record.width === "number" ? record.width : undefined;
  const height = typeof record.height === "number" ? record.height : undefined;
  return width !== undefined && height !== undefined
    ? { width, height }
    : undefined;
}

function fontFamilyFromPath(path: string): string {
  return path.includes("/roboto/") || /roboto/i.test(path)
    ? "Roboto Fixture"
    : (path
        .split("/")
        .at(-1)
        ?.replace(/\.[^.]+$/, "") ?? "Godot Fixture Font");
}

function fontStyleFromPath(path: string): "normal" | "italic" {
  return /italic/i.test(path) ? "italic" : "normal";
}

function fontWeightFromPath(path: string): string {
  return /bold/i.test(path) ? "700" : "400";
}

function fontWeightFromVariationDocument(
  document: ReturnType<typeof loadFixtureResource>,
): string | undefined {
  const variation = document.properties.variation_opentype;
  if (
    !variation ||
    typeof variation !== "object" ||
    Array.isArray(variation) ||
    "type" in variation
  ) {
    return undefined;
  }
  const value = (variation as Record<string, unknown>)["2003265652"];
  return typeof value === "number" ? String(value) : undefined;
}

function extResource(
  scene: GodotSceneState,
  ref: GodotResourceRefValue,
): GodotExtResource | undefined {
  return ref.type === "ExtResource"
    ? scene.extResources.find((resource) => resource.id === ref.id)
    : undefined;
}

function parseGodotSceneResource(
  repoRoot: string,
  path: string,
): GodotSceneState {
  const filePath = resolveResourceFilePath(repoRoot, path);
  const scene = parseGodotTextScene(readFileSyncUtf8(filePath), {
    path: filePath,
  });
  tagSceneNodes(scene, path);
  return scene;
}

function loadFixtureResource(repoRoot: string, path: string) {
  const filePath = resolveResourceFilePath(repoRoot, path);
  return parseGodotResource(readFileSyncUtf8(filePath), { path: filePath });
}

function resolveResourceFilePath(repoRoot: string, path: string): string {
  if (!path.startsWith("res://fixtures/")) {
    throw new Error(
      `Parity fixture resource must be under res://fixtures/: ${path}`,
    );
  }
  return resolve(repoRoot, path.replace(/^res:\/\//, ""));
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code}\n${stdout}\n${stderr}`,
        ),
      );
    });
  });
}

function findRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function parityArtifactRelativePath(path: string): string {
  return relative(findRepoRoot(), path);
}

function parityArtifactName(repoRoot: string, fixturePath: string): string {
  const fixturesRoot = join(repoRoot, "fixtures");
  const fixtureRelativePath = relative(fixturesRoot, fixturePath);
  const withoutExtension = fixtureRelativePath.slice(
    0,
    -extname(fixtureRelativePath).length,
  );
  return withoutExtension
    .split(sep)
    .map((part) => part.replace(/[^A-Za-z0-9_.-]/g, "-"))
    .join(sep);
}
