// @vitest-environment node
//
// The Chrome launch line, asserted without launching Chrome.
//
// `chromeArgs` is measurement configuration, not plumbing: renderer backgrounding, timer throttling,
// occlusion calculation and the colour profile are all pinned here, and a quiet edit to any of them
// moves every number this harness reports. The literal below is the exact list the harness launched
// with BEFORE the args were extracted into a pure function — it is a change detector on purpose.

import { describe, expect, it } from "vitest";
import { chromeArgs } from "../src/cdp";

const DEFAULTS = [
  "--remote-debugging-port=0",
  "--user-data-dir=/artifacts/chrome-profile",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=CalculateNativeWinOcclusion,BackForwardCache",
  "--force-color-profile=srgb",
  "--hide-scrollbars",
  "--mute-audio",
  "--force-device-scale-factor=1",
  "--window-size=1280,800",
  "--headless=new",
  "about:blank",
];

describe("chromeArgs", () => {
  it("with no extra flags is byte-identical to the pre-extraction launch line", () => {
    expect(chromeArgs({ profileDir: "/artifacts/chrome-profile" })).toEqual(
      DEFAULTS,
    );
  });

  it("takes the same defaults whether or not the optional knobs are spelled out", () => {
    // 1280x800 at dpr 1 headless IS the committed desktop baseline's geometry; the defaults and the
    // explicit spelling must not drift apart, or `--viewport 1280x800` would measure a different run
    // from the default one.
    expect(
      chromeArgs({
        profileDir: "/artifacts/chrome-profile",
        headless: true,
        windowSize: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        extraArgs: [],
      }),
    ).toEqual(DEFAULTS);
  });

  it("appends extra flags after the defaults and before the URL", () => {
    const args = chromeArgs({
      profileDir: "/artifacts/chrome-profile",
      extraArgs: ["--enable-unsafe-webgpu"],
    });
    // Last-wins is how Chrome reads repeated switches, so extras must come after everything this
    // harness set; `about:blank` is positional and must stay last or Chrome opens the flag as a URL.
    expect(args.slice(0, DEFAULTS.length - 1)).toEqual(
      DEFAULTS.slice(0, DEFAULTS.length - 1),
    );
    expect(args.slice(-2)).toEqual(["--enable-unsafe-webgpu", "about:blank"]);
  });

  it("keeps repeated extra flags in the order they were given", () => {
    const args = chromeArgs({
      profileDir: "/artifacts/chrome-profile",
      extraArgs: [
        "--enable-unsafe-webgpu",
        "--use-webgpu-adapter=swiftshader",
        "--enable-features=Vulkan",
      ],
    });
    expect(args.slice(-4)).toEqual([
      "--enable-unsafe-webgpu",
      "--use-webgpu-adapter=swiftshader",
      "--enable-features=Vulkan",
      "about:blank",
    ]);
  });

  it("adds --headless=new only when headless", () => {
    expect(chromeArgs({ profileDir: "/p", headless: true })).toContain(
      "--headless=new",
    );
    expect(chromeArgs({ profileDir: "/p", headless: false })).not.toContain(
      "--headless=new",
    );
    // `--headed` must change ONLY that switch: a headed debugging run has to be the same browser.
    expect(chromeArgs({ profileDir: "/p", headless: false })).toEqual(
      chromeArgs({ profileDir: "/p", headless: true }).filter(
        (arg) => arg !== "--headless=new",
      ),
    );
  });

  it("carries the window size and device scale factor into the launch line", () => {
    const args = chromeArgs({
      profileDir: "/p",
      windowSize: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
    });
    expect(args).toContain("--window-size=412,915");
    expect(args).toContain("--force-device-scale-factor=2.625");
  });
});
