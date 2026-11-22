// Reproducible real-consumer assertions; invoked by run.sh under its per-leg quiet lock.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type {
  Draw,
  Trace,
} from "../../../../apps/playground/src/client-tweens-check";
import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  launchHarnessBrowser,
} from "../../scripts/lib/browser-harness";

const [out, port, pagePort, sabotage] = process.argv.slice(2);
assert(
  out && port && pagePort,
  "usage: check.ts OUT HOST_PORT PAGE_PORT [--sabotage-disabled]",
);
const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const checks: { name: string; passed: boolean; detail?: string }[] = [];
const check = (name: string, run: () => void) => {
  try {
    run();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, detail: String(error) });
  }
};
const server = await createServer({
  configFile: join(root, "apps/playground/vite.config.ts"),
  root: join(root, "apps/playground"),
  server: {
    host: "127.0.0.1",
    port: Number(pagePort),
    strictPort: true,
    fs: { allow: [root] },
  },
});
await server.listen();
const launched = await launchHarnessBrowser();
try {
  const page = await launched.browser.newPage({
    viewport: { width: 660, height: 870 },
  });
  page.on("pageerror", (error) => console.error(error));
  const query = new URLSearchParams({
    host: port,
    core: `/@fs${join(out, "core")}`,
  });
  if (sabotage === "--sabotage-disabled") query.set("sabotage", "disabled");
  await page.goto(
    `${server.resolvedUrls!.local[0]}client-tweens.html?${query}`,
  );
  await page.waitForFunction(
    () => Reflect.get(window, "tweenCheck")?.ready,
    null,
    {
      timeout: 40000,
    },
  );
  const provenance = await checkBrowserProvenance(
    page,
    launched,
    [...BROWSER_LAUNCH_ARGS, ...BACKGROUND_THROTTLING_ARGS],
    {},
  );
  writeFileSync(
    join(out, "browser-provenance.json"),
    JSON.stringify(provenance, null, 2),
  );
  assert(provenance.ok, JSON.stringify(provenance));
  await page.evaluate(() => Reflect.get(window, "tweenCheck").start());
  writeFileSync(join(out, "start"), "start\n");
  await page.waitForFunction(
    () => {
      const traces = Reflect.get(window, "tweenCheck").traces;
      return (
        traces.enabled.transactions.length > 28 &&
        traces.disabled.transactions.length > 28
      );
    },
    null,
    { timeout: 15000 },
  );
  const result = (await page.evaluate(() => {
    const probe = Reflect.get(window, "tweenCheck");
    return {
      traces: probe.traces,
      stats: probe.stats(),
      recordings: probe.recordings(),
    };
  })) as {
    traces: { enabled: Trace; disabled: Trace };
    stats: unknown[];
    recordings: number[][];
  };
  // Recordings preserve host t_us and tween records byte-for-byte, without the wire coding envelope.
  for (const [i, label] of ["enabled", "disabled"].entries()) {
    writeFileSync(
      join(out, `${label}.rs17`),
      Buffer.from(result.recordings[i]),
    );
    const trace = result.traces[label as "enabled" | "disabled"];
    for (const [phase, data] of Object.entries(trace.shots)) {
      writeFileSync(
        join(out, `${label}-${phase}.png`),
        Buffer.from(data.split(",")[1], "base64"),
      );
      trace.shots[phase] = join(out, `${label}-${phase}.png`);
    }
  }
  await page.screenshot({ path: join(out, "comparison.png"), fullPage: true });
  writeFileSync(
    join(out, "traces.json"),
    JSON.stringify({ traces: result.traces, stats: result.stats }),
  );
  const { enabled, disabled } = result.traces;
  const findRow = (trace: Trace, y: number) => {
    const row = trace.draws[0].rows.findIndex(
      (r) => r && Math.abs(r[4] - 70) < 0.01 && Math.abs(r[5] - y) < 0.01,
    );
    assert(row >= 0, `missing uploaded item at 70,${y}`);
    return row;
  };
  const node = findRow(enabled, 90);
  const control = findRow(enabled, 240);
  const offNode = findRow(disabled, 90);
  const value = (d: Draw, row: number) => d.rows[row];
  const diff = (a: number[], b: number[]) =>
    Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const angle = (r: number[]) => Math.atan2(r[1], r[0]);
  const scale = (r: number[]) => Math.hypot(r[0], r[1]);
  const last = enabled.draws.at(-1)!;
  check("two begins, cancel and completion from real capture", () => {
    assert.equal(last.diag.begins, 2);
    assert.equal(last.diag.cancels, 1);
    assert.equal(last.diag.completed, 1);
    assert(last.diag.tween_redraws > 0);
  });
  const [hold] = enabled.holds;
  const held = enabled.draws.filter(
    (d) => d.at > hold.start + 50 && d.at < hold.end - 50,
  );
  const offHeld = disabled.draws.filter(
    (d) =>
      d.at > disabled.holds[0].start + 50 && d.at < disabled.holds[0].end - 50,
  );
  check(
    "distinct drawn poses strictly between received and drawn transactions",
    () => {
      assert(held.length >= 3, `only ${held.length} held draws`);
      assert.equal(new Set(held.map((d) => d.seq)).size, 1);
      const first = held[0];
      const end = held.at(-1)!;
      const priorReceived = enabled.transactions.find(
        (t) => t.seq === first.seq,
      )!;
      const nextReceived = enabled.transactions.find((t) => t.seq > first.seq)!;
      const priorDrawn = enabled.draws.find((d) => d.seq === first.seq)!;
      const nextDrawn = enabled.draws.find((d) => d.seq > first.seq)!;
      assert(priorReceived.at < first.at && priorDrawn.at < first.at);
      assert(
        end.at < nextReceived.at && end.at < nextDrawn.at && first.at < end.at,
      );
      assert(
        diff(
          first.host.find((it) => it.xform[5] < 150 && it.xform[4] > 50)!.xform,
          end.host.find((it) => it.xform[5] < 150 && it.xform[4] > 50)!.xform,
        ) === 0,
      );
      for (const row of [node, control]) {
        const a = value(first, row);
        const b = value(end, row);
        assert(Math.abs(a[4] - b[4]) > 1, "position did not advance");
        assert(
          Math.abs(angle(a) - angle(b)) > 0.01,
          "rotation did not advance",
        );
        assert(Math.abs(scale(a) - scale(b)) > 0.01, "scale did not advance");
        assert(
          diff(a.slice(6, 10), b.slice(6, 10)) > 0.01,
          "modulate did not advance",
        );
      }
      assert(
        diff(first.pixel, end.pixel) > 0,
        "rendered pixels did not change",
      );
    },
  );
  check(
    "disabled client keeps host poses and does not redraw during withheld interval",
    () => {
      assert.equal(offHeld.length, 0);
      assert(
        !disabled.draws.some(
          (d, i) => i > 0 && d.seq === disabled.draws[i - 1].seq,
        ),
      );
      for (const d of disabled.draws) {
        const row = value(d, offNode);
        const host = d.host.find(
          (it) =>
            Math.abs(it.xform[5] - row[5]) < 0.01 &&
            Math.abs(it.xform[4] - row[4]) < 0.01,
        );
        assert(host, `no host pose for disabled draw ${d.seq}`);
        assert(diff(row.slice(0, 6), host.xform) < 0.0001);
      }
    },
  );
  check("no tween redraw after all tweens have retired", () => {
    const completed = enabled.draws.findIndex((d) => d.diag.completed > 0);
    assert(completed >= 0);
    const tail = enabled.draws.slice(completed);
    assert(tail.length > 3);
    assert.equal(new Set(tail.map((d) => d.seq)).size, tail.length);
  });
  const residuals: Record<string, unknown> = {};
  for (const [name, key, rowIndex] of [
    ["cancel", "cancels", control],
    ["completion", "completed", node],
  ] as const) {
    const index = enabled.draws.findIndex((d) => d.diag[key] > 0);
    check(`${name} hands over to the latest host baseline`, () => {
      assert(index > 0, `missing ${name}`);
      const d = enabled.draws[index];
      const r = value(d, rowIndex);
      const host = d.host.find((it) => diff(it.xform, r.slice(0, 6)) < 0.0001);
      assert(host, `handover xform differs from host for ${name}`);
      assert(diff(host.modulate, r.slice(6, 10)) < 0.0001);
    });
    if (index > 0) {
      const previous = value(enabled.draws[index - 1], rowIndex);
      const current = value(enabled.draws[index], rowIndex);
      const point = (r: number[], x: number, y: number) => [
        r[0] * x + r[2] * y + r[4],
        r[1] * x + r[3] * y + r[5],
      ];
      const corners = [
        [0, 0],
        [40, 0],
        [40, 28],
        [0, 28],
      ];
      residuals[name] = {
        at_ms: enabled.draws[index].at,
        max_corner_px: Math.max(
          ...corners.map(([x, y]) => {
            const a = point(previous, x, y);
            const b = point(current, x, y);
            return Math.hypot(a[0] - b[0], a[1] - b[1]);
          }),
        ),
        rotation_rad: Math.abs(angle(current) - angle(previous)),
        origin_px: Math.hypot(
          current[4] - previous[4],
          current[5] - previous[5],
        ),
        scale_x_ratio: Math.abs(scale(current) - scale(previous)),
        scale_y_ratio: Math.abs(
          Math.hypot(current[2], current[3]) -
            Math.hypot(previous[2], previous[3]),
        ),
        modulate_channels: current
          .slice(6, 10)
          .map((v, i) => Math.abs(v - previous[i + 6])),
        modulate_channel: diff(current.slice(6, 10), previous.slice(6, 10)),
      };
    }
  }
  check("intermediate and handover screenshots preserved", () => {
    for (const phase of ["intermediate", "cancel", "completion"])
      assert(enabled.shots[phase]);
  });
  const intervals = enabled.transactions
    .slice(1)
    .map((t, i) => (t.t_us - enabled.transactions[i].t_us) / 1000)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  check("capture transactions throttled to approximately 10/s", () =>
    assert(median >= 80 && median <= 140, `${median} ms median`),
  );
  writeFileSync(
    join(out, "traces.json"),
    JSON.stringify({ traces: result.traces, stats: result.stats }),
  );
  const summary = {
    checks,
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
    skipped: 0,
    withheld_draws: held.length,
    disabled_withheld_draws: offHeld.length,
    transaction_interval_median_ms: median,
    residuals,
    core: JSON.parse(readFileSync(join(out, "core/build.json"), "utf8")),
  };
  writeFileSync(join(out, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.failed ? 1 : 0;
} finally {
  await launched.browser.close();
  await server.close();
}
