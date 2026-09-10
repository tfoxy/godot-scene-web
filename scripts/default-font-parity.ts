import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runParityFixtures } from "../packages/test-harness/src/parity";

const fixtures = [
  {
    path: "fixtures/text-alignment/rich-theme.tscn",
    run: "Bold",
    tolerance: 2,
  },
  {
    path: "fixtures/parser/multiline-editable.tscn",
    run: "First line",
    tolerance: 1,
  },
] as const;

const results = await runParityFixtures(
  fixtures.map((fixture) => ({
    fixturePath: fixture.path,
    noGodotScreenshot: true,
  })),
);

for (const fixture of fixtures) {
  const result = results.find(
    (candidate) => candidate.fixturePath === resolve(fixture.path),
  );
  if (!result?.ok) {
    throw new Error(`default-font parity failed for ${fixture.path}`);
  }
  const [live, dom] = await Promise.all(
    [result.godotLiveTreePath, result.browserDomTreePath].map(
      async (path) =>
        JSON.parse(await readFile(path, "utf8")) as {
          nodes: Array<{
            textRuns?: Array<{ text: string; rect: { width: number } }>;
          }>;
        },
    ),
  );
  const width = (tree: typeof live) => {
    for (const node of tree.nodes) {
      const run = node.textRuns?.find(
        (candidate) => candidate.text === fixture.run,
      );
      if (run) return run.rect.width;
    }
    throw new Error(`${fixture.run} was not collected for ${fixture.path}`);
  };
  const delta = Math.abs(width(live) - width(dom));
  if (delta > fixture.tolerance) {
    throw new Error(
      `${fixture.path} ${fixture.run} width delta ${delta}px exceeds its existing ${fixture.tolerance}px tolerance`,
    );
  }
  process.stdout.write(
    `${fixture.path}: ${fixture.run} width ${width(live)}px / ${width(dom)}px (delta ${delta}px, tolerance ${fixture.tolerance}px)\n`,
  );
}
