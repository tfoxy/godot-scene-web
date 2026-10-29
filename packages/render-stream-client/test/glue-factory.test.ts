import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build script, no declarations
import { glueFactory } from "../scripts/glue-factory.mjs";

const GLUE = `let wasm;
export class GswRs { constructor() { this.m = wasm; } }
export class LiveCoding {}
export function core_bench() { return 1; }
function initSync(module) { wasm = { module }; return wasm; }
async function __wbg_init(o) { wasm = { o, url: new URL('x.wasm', import.meta.url).href }; return wasm; }
export { initSync, __wbg_init as default };
`;

async function load(source: string) {
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return (await import(/* @vite-ignore */ url)) as {
    default: () => Record<string, unknown>;
    RENDER_STREAM_CLIENT_GLUE: number;
  };
}

describe("glue-factory", () => {
  it("wraps the glue so that each call is a fresh instance", async () => {
    const m = await load(glueFactory(GLUE));
    expect(m.RENDER_STREAM_CLIENT_GLUE).toBe(1);
    const a = m.default();
    const b = m.default();
    expect(Object.keys(a).sort()).toEqual(
      ["GswRs", "LiveCoding", "core_bench", "default", "initSync"].sort(),
    );
    expect(a.GswRs).not.toBe(b.GswRs);
    const ia = (a.initSync as (m: number) => unknown)(1);
    const ib = (b.initSync as (m: number) => unknown)(2);
    expect(ia).not.toBe(ib);
    expect(new (a.GswRs as new () => { m: unknown })().m).toBe(ia);
  });

  it.each([
    ["an import", `import x from "./snippets/a.js";\n${GLUE}`],
    [
      "no closing export",
      GLUE.replace("export { initSync, __wbg_init as default };", ""),
    ],
    ["an unknown export", `${GLUE}export const X = 1;\n`],
    ["no GswRs", GLUE.replace("export class GswRs", "class GswRs")],
  ])("refuses a glue with %s", (_why, source) => {
    expect(() => glueFactory(source)).toThrow(/glue-factory/);
  });
});
