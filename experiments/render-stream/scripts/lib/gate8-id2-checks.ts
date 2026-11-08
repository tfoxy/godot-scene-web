// ID4: the public client's host-fed picks, runtime restamps and unchanged /13 offers/hellos.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type G8aCheck, skipped } from "./gate8-adopt-checks";
import { mismatches, NEVER, PICKED, type PickOracle } from "./gate8-id-checks";

interface Report {
  gpuFormats: string;
  mode: string;
  sabotage: string | null;
  provenance: { ok: boolean };
  statuses: {
    kind: string;
    firstFrame?: boolean;
    reason?: string;
    detail?: string;
  }[];
  offers: string[];
  hellos: string[];
  grant: { fields: string[] } | null;
  statements: number;
  pick: {
    size: [number, number];
    grid: [number, number];
    points: (string | null)[];
  } | null;
  samples: {
    seq: number;
    frame: number;
    target: string | null;
    instanceId?: string;
  }[];
}
interface OracleLine {
  process_frames: number;
  flips?: { step: number; node: string; mouse_filter: number }[];
}
const read = <T>(p: string): T | null =>
  existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
const lines = <T>(p: string): T[] =>
  existsSync(p)
    ? readFileSync(p, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

/** The same assertion judges the honest leg and its precedence sabotage. */
export function restampProblems(
  samples: Report["samples"],
  oracle: OracleLine[],
): string[] {
  const problems: string[] = [];
  const flips = oracle.flatMap((l) =>
    (l.flips ?? [])
      .filter((f) => f.node === "Flipper" && (f.step === 40 || f.step === 50))
      .map((f) => ({ ...f, frame: l.process_frames + 1 })),
  );
  if (flips.length !== 2)
    problems.push(`expected 2 Flipper flips, got ${flips.length}`);
  for (const f of flips) {
    const before = samples
      .filter((s) => s.frame > 0 && s.frame < f.frame)
      .at(-1);
    const after = samples.find(
      (s) =>
        s.frame >= f.frame &&
        s.frame <= f.frame + 2 &&
        (f.mouse_filter === 2
          ? s.target !== "Flipper"
          : s.target === "Flipper"),
    );
    if (
      !before ||
      (f.mouse_filter === 2
        ? before.target !== "Flipper"
        : before.target === "Flipper")
    )
      problems.push(
        `step ${f.step}: no opposite target before frame ${f.frame}`,
      );
    if (!after)
      problems.push(
        `step ${f.step}: target did not change within 2 frames of frame ${f.frame}`,
      );
    if (after?.target === "Flipper" && !/^\d+$/.test(after.instanceId ?? ""))
      problems.push(
        `step ${f.step}: resolved Flipper has no decimal instanceId`,
      );
  }
  return problems;
}

// Fixed /13 wire bytes. Keep independent of clientHello so serializer changes cannot bless themselves.
export const PURE_HELLO =
  '{"type":"hello","protocol":"render-stream/13","receiver":"gsw-render-stream-client","receiver_kind":"gsw-canvas","credit_stage":"submitted","credit_window":2,"inbound_buffer_bytes":16777216,"token":null,"manifest_sha256":null,"presentation_backing_w":640,"presentation_backing_h":360,"presentation_css_w":640,"presentation_css_h":360,"dpr_milli":1000,"texture_encodings":"decoded","gpu_formats":"none","live_coding":"zstd-base,zstd"}';
export const TAG1_HELLO =
  PURE_HELLO.slice(0, -1) +
  ',"item_meta":{"fields":["class","scene","path"],"groups":[],"meta_keys":[]}}';

export async function runG8id2(g: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const health = (leg: string) => {
    const r = read<Report>(join(g, leg, "page", "client-id2.json"));
    const problems: string[] = [];
    if (!r) problems.push(`${leg}: no client-id2.json`);
    else {
      if (!r.provenance?.ok) problems.push(`${leg}: browser provenance failed`);
      if (!r.statuses.some((s) => s.kind === "streaming" && s.firstFrame))
        problems.push(`${leg}: no first frame`);
      if (!r.statuses.some((s) => s.kind === "ended"))
        problems.push(
          `${leg}: did not end (${JSON.stringify(r.statuses.find((s) => s.kind === "failed"))})`,
        );
    }
    return { r, problems };
  };
  const run = (
    id: string,
    leg: string,
    criterion: string,
    judge: (r: Report) => string[],
  ) => {
    const why = skipped(join(g, leg));
    if (why !== null) {
      checks.push({
        id,
        criterion,
        passed: true,
        status: "not-run",
        gating: false,
        detail: why,
      });
      return;
    }
    const { r, problems } = health(leg);
    if (r) problems.push(...judge(r));
    checks.push({
      id,
      criterion,
      passed: problems.length === 0,
      status: problems.length === 0 ? "pass" : "fail",
      gating: true,
      detail: problems.length
        ? problems.slice(0, 8).join("; ")
        : `${leg}: passed`,
    });
  };
  run(
    "pick-oracle-host",
    "pick",
    "Host-fed filters with no consumer statements or pickOrder call equal Godot at all 384 grid points",
    (r) => {
      const p: string[] = [];
      const o = lines<PickOracle>(join(g, "pick/host/pick-oracle.json"))[0];
      if (r.statements !== 0)
        p.push("consumer statements used in host-only pick");
      if (
        r.offers.length !== 1 ||
        r.offers[0] !== "render-stream.14" ||
        !r.grant?.fields.includes("mouse_filter")
      )
        p.push("no /14 mouse_filter session");
      if (
        !o ||
        !r.pick ||
        o.points.length !== 384 ||
        r.pick.points.length !== 384
      )
        return [...p, "missing or incomplete grid"];
      if (
        JSON.stringify(o.size) !== JSON.stringify(r.pick.size) ||
        JSON.stringify(o.grid) !== JSON.stringify(r.pick.grid)
      )
        p.push("grid geometry differs");
      const seen = new Set(o.points);
      for (const n of PICKED)
        if (!seen.has(n)) p.push(`oracle never picks ${n}`);
      for (const n of NEVER) if (seen.has(n)) p.push(`oracle picks ${n}`);
      return [...p, ...mismatches(o, r.pick.points)];
    },
  );
  const judgeRestamp = (leg: string, r: Report) => {
    const p = restampProblems(
      r.samples,
      lines<OracleLine>(join(g, leg, "host/oracle.jsonl")),
    );
    if (r.statements < 1) p.push("no conflicting consumer STOP statement");
    if (
      r.offers.length !== 1 ||
      r.offers[0] !== "render-stream.14" ||
      !r.grant?.fields.includes("mouse_filter")
    )
      p.push("no /14 mouse_filter session");
    return p;
  };
  run(
    "restamp-reaches-pick",
    "restamp",
    "Flipper changes its resolved target within 2 host frames of both runtime flips despite a stale consumer STOP",
    (r) => judgeRestamp("restamp", r),
  );
  run(
    "hello-pure",
    "pure",
    "extensions: [] connects at /13 with byte-identical hello",
    (r) =>
      r.offers.length === 1 &&
      r.offers[0] === "render-stream.13" &&
      r.hellos.length === 1 &&
      r.hellos[0] ===
        PURE_HELLO.replace(
          '"gpu_formats":"none"',
          `"gpu_formats":"${r.gpuFormats}"`,
        )
        ? []
        : ["pure offer or hello bytes changed"],
  );
  run(
    "hello-tag1",
    "tag1",
    "TAG1-only wants connect at /13 with byte-identical hello",
    (r) =>
      r.offers.length === 1 &&
      r.offers[0] === "render-stream.13" &&
      r.hellos.length === 1 &&
      r.hellos[0] ===
        TAG1_HELLO.replace(
          '"gpu_formats":"none"',
          `"gpu_formats":"${r.gpuFormats}"`,
        )
        ? []
        : ["TAG1 offer or hello bytes changed"],
  );
  run(
    "sabotage-ignore-host-filter-caught",
    "sabotage-ignore-host-filter",
    "Consumer precedence sabotage fails restamp-reaches-pick",
    (r) => {
      if (r.sabotage !== "ignore-host-filter" || r.statements < 1)
        return ["sabotage not enabled or no conflicting statement"];
      const failures = judgeRestamp("sabotage-ignore-host-filter", r);
      return failures.some((p) =>
        p.includes("target did not change within 2 frames"),
      )
        ? []
        : ["ignore-host-filter did not fail restamp-reaches-pick"];
    },
  );
  return checks;
}
