// Real-browser (Chromium) regression coverage for CSS Anchor Positioning behaviors this
// codebase's hover-tip CSS-anchor migration (spirectl `hoverTipAnchorCss.ts` /
// `SpirectlPresentationView.ts`) depends on. jsdom/happy-dom implement none of this, so it can
// only be verified against a real engine — these were each confirmed manually against a live
// Chromium render before being encoded here as a lasting regression, per this repo's convention
// of running real browser-launching assertions through vitest (see `parity.ts`'s `chromium.launch()`
// usage) rather than a separate `@playwright/test` runner config.
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

async function render(html: string): Promise<import("@playwright/test").Page> {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;padding:0;width:800px;height:600px;position:relative}</style></head><body>${html}</body></html>`,
    { waitUntil: "load" },
  );
  return page;
}

async function rect(page: import("@playwright/test").Page, selector: string) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}

describe("CSS Anchor Positioning — cross-container teleport (the hover-tip shape)", () => {
  // Mirrors game.tscn: an owner nested inside RootSceneContainer, a tip teleported into a
  // SEPARATE HoverTipsContainer sibling. The old hoverTipFit.ts comment claimed this could never
  // resolve via CSS (containing-block mismatch); it resolves fine PROVIDED the teleport
  // container itself does not establish a containing block (no position:absolute/relative/fixed
  // on the container element) — this is the load-bearing constraint the migration depends on.
  it("resolves when the teleport container does NOT establish its own containing block", async () => {
    const page = await render(`
      <div id="root-scene-container" style="position:absolute;inset:0">
        <div id="wrap" style="position:absolute;inset:0">
          <div id="owner" style="position:absolute;top:10px;right:10px;width:48px;height:40px;anchor-name:--o"></div>
        </div>
      </div>
      <div id="hover-tips-container">
        <div id="tip" style="position:absolute;top:calc(anchor(--o bottom) + 20px);right:anchor(--o right);width:200px;height:60px"></div>
      </div>
    `);
    const owner = await rect(page, "#owner");
    const tip = await rect(page, "#tip");
    expect(tip.top).toBeCloseTo(owner.bottom + 20, 0);
    expect(tip.right).toBeCloseTo(owner.right, 0);
    await page.close();
  });

  it("does NOT resolve (falls back to static position) when the teleport container DOES establish its own containing block", async () => {
    const page = await render(`
      <div id="root-scene-container" style="position:absolute;inset:0">
        <div id="owner" style="position:absolute;top:10px;right:10px;width:48px;height:40px;anchor-name:--o"></div>
      </div>
      <div id="hover-tips-container" style="position:absolute;inset:0">
        <div id="tip" style="position:absolute;top:calc(anchor(--o bottom) + 20px);right:anchor(--o right);width:200px;height:60px"></div>
      </div>
    `);
    const tip = await rect(page, "#tip");
    // Anchor doesn't resolve → falls to its static-position algorithm → lands at the container origin.
    expect(tip.left).toBeCloseTo(0, 0);
    expect(tip.top).toBeCloseTo(0, 0);
    await page.close();
  });

  // spirectl's HoverTipsContainer needs a stacking context (tips must paint above the scene)
  // WITHOUT establishing a containing block — `isolation: isolate` is the property that gives
  // exactly that (unlike `position`, which gives both). Confirms `isolation` alone doesn't
  // interfere with anchor() resolution.
  it("resolves through a teleport container using isolation:isolate for stacking (not position)", async () => {
    const page = await render(`
      <div id="root-scene-container" style="position:absolute;inset:0">
        <div id="owner" style="position:absolute;top:10px;right:10px;width:48px;height:40px;anchor-name:--o"></div>
      </div>
      <div id="hover-tips-container" style="isolation:isolate">
        <div id="tip" style="position:absolute;top:calc(anchor(--o bottom) + 20px);right:anchor(--o right);width:200px;height:60px"></div>
      </div>
    `);
    const owner = await rect(page, "#owner");
    const tip = await rect(page, "#tip");
    expect(tip.top).toBeCloseTo(owner.bottom + 20, 0);
    expect(tip.right).toBeCloseTo(owner.right, 0);
    await page.close();
  });
});

describe("CSS Anchor Positioning — position-try-fallbacks: flip-inline", () => {
  it("flips a right-anchored box to the owner's opposite edge when it would overflow the viewport", async () => {
    const page = await render(`
      <div id="owner" style="position:absolute;top:300px;right:20px;width:40px;height:40px;anchor-name:--o"></div>
      <div id="tip" style="position:absolute;top:anchor(--o top);left:anchor(--o right);width:360px;height:50px;position-try-fallbacks:flip-inline"></div>
    `);
    const owner = await rect(page, "#owner");
    const tip = await rect(page, "#tip");
    // Flipped: tip's right edge flush at the owner's left edge (not off-screen to the right).
    expect(tip.right).toBeCloseTo(owner.left, 0);
    await page.close();
  });

  it("does not flip when the default placement already fits", async () => {
    const page = await render(`
      <div id="owner" style="position:absolute;top:300px;left:20px;width:40px;height:40px;anchor-name:--o"></div>
      <div id="tip" style="position:absolute;top:anchor(--o top);left:anchor(--o right);width:200px;height:50px;position-try-fallbacks:flip-inline"></div>
    `);
    const owner = await rect(page, "#owner");
    const tip = await rect(page, "#tip");
    expect(tip.left).toBeCloseTo(owner.right, 0);
    await page.close();
  });
});

describe("CSS Anchor Positioning — position-try-fallbacks: flip-block", () => {
  // The relic-tooltip "flip above the owner instead of below" case (spirectl's
  // hoverTipAnchorCss.ts "below" placement, mirroring the game's NHoverTipSet.SetAlignmentForRelic
  // pre-emptive vertical flip — except CSS reacts to ACTUAL overflow rather than a static
  // viewportHeight*0.75 threshold). Spiked against a real Chromium render before relying on it:
  // the built-in `flip-block` tactic correctly mirrors the authored margin onto the flipped side
  // (a `top: calc(anchor(bottom) + 20px)` rule becomes an effective `bottom: anchor(top) - 20px`
  // once flipped — same 20px gap, no sign-correction or custom `@position-try` rule needed).
  it("flips a below-anchored box to render ABOVE the owner, preserving the authored margin, when it would overflow the viewport bottom", async () => {
    const page = await render(`
      <div id="owner" style="position:absolute;top:550px;left:300px;width:48px;height:40px;anchor-name:--o"></div>
      <div id="tip" style="position:absolute;top:calc(anchor(--o bottom) + 20px);left:anchor(--o left);width:200px;height:60px;position-try-fallbacks:flip-block"></div>
    `);
    const owner = await rect(page, "#owner");
    const tip = await rect(page, "#tip");
    // Flipped: tip's bottom edge sits 20px above the owner's top edge (the same 20px gap, mirrored).
    expect(owner.top - tip.bottom).toBeCloseTo(20, 0);
    await page.close();
  });

  it("does not flip when the default below placement already fits", async () => {
    const page = await render(`
      <div id="owner" style="position:absolute;top:100px;left:300px;width:48px;height:40px;anchor-name:--o"></div>
      <div id="tip" style="position:absolute;top:calc(anchor(--o bottom) + 20px);left:anchor(--o left);width:200px;height:60px;position-try-fallbacks:flip-block"></div>
    `);
    const owner = await rect(page, "#owner");
    const tip = await rect(page, "#tip");
    expect(tip.top - owner.bottom).toBeCloseTo(20, 0);
    await page.close();
  });
});

describe("CSS Anchor Positioning — align-self: anchor-center for a dynamic-height box", () => {
  it("centers a box of unknown height on the owner's full span, with no fixed-height assumption", async () => {
    const page = await render(`
      <div id="owner" style="position:absolute;top:200px;left:300px;width:40px;height:100px;anchor-name:--o"></div>
      <div id="tip" style="position:absolute;left:anchor(--o right);top:anchor(--o top);bottom:anchor(--o bottom);align-self:anchor-center;width:200px">Short</div>
    `);
    const owner = await rect(page, "#owner");
    const tip = await rect(page, "#tip");
    const ownerCenter = (owner.top + owner.bottom) / 2;
    const tipCenter = (tip.top + tip.bottom) / 2;
    expect(tipCenter).toBeCloseTo(ownerCenter, 0);
    await page.close();
  });
});

describe("CSS Anchor Positioning — device-fit stage scale (transform: scale on an ancestor)", () => {
  it("a calc() offset authored in design px scales proportionally with an ancestor transform:scale — no runtime JS multiplication needed", async () => {
    const page = await render(`
      <div id="stage" style="position:absolute;inset:0;transform:scale(0.5);transform-origin:top left">
        <div id="owner" style="position:absolute;top:10px;right:10px;width:48px;height:40px;anchor-name:--o"></div>
        <div id="tip" style="position:absolute;top:calc(anchor(--o bottom) + 20px);right:anchor(--o right);width:200px;height:60px"></div>
      </div>
    `);
    const owner = await rect(page, "#owner");
    const tip = await rect(page, "#tip");
    // Design-space 20px gap, scaled 0.5x by the ancestor transform → 10 screen px.
    expect(tip.top - owner.bottom).toBeCloseTo(10, 0);
    expect(tip.right).toBeCloseTo(owner.right, 0);
    await page.close();
  });
});

describe("CSS Anchor Positioning — anchor() tracks the owner's CSS transform", () => {
  it("re-tracks a scaled owner's transformed (not pre-transform) geometry — no JS refit needed for a focus-lift", async () => {
    const page = await render(`
      <div id="owner" style="position:absolute;top:200px;left:300px;width:100px;height:100px;anchor-name:--o;transform:scale(1.5);transform-origin:center center"></div>
      <div id="tip" style="position:absolute;left:anchor(--o right);top:anchor(--o top);width:150px;height:40px"></div>
    `);
    const owner = await rect(page, "#owner");
    const tip = await rect(page, "#tip");
    expect(tip.left).toBeCloseTo(owner.right, 0);
    expect(tip.top).toBeCloseTo(owner.top, 0);
    await page.close();
  });
});
