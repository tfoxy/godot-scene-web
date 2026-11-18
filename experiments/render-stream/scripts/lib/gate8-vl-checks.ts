// Gate 8 g8vl checks (VS4: render-stream/16 viewport surfaces served LIVE to a browser receiver, and
// the client's `viewports` option). run-gate8.sh run_g8vl writes, under g8vl/ (browser legs only:
// `run-gate7.sh --live --legs g7-vp` sets GATE7_LIVE_KIND, without it the group leaves
// skipped.txt):
//
//   reference/capture   a rendered /16 file-sink capture of the born fixture: its own Godot shots
//                       (shots/step-<k>.png) and steps.jsonl, the same capture g8vp's born-rendered is
//   on/host             a headless live host at /16 (GRC_STREAM_VERSION=16, res://born.tscn)
//   on/receiver         a browser GSW receiver at RS_RECEIVER_PROTOCOL=16 (render-stream.16 offered
//                       alone), the default client (`viewports` on); shots/final.png, applied.json
//   client-off/{host,receiver}  the same with RS_RECEIVER_VIEWPORTS=off (the client's
//                       `viewports: false`)
//   late/{host,receiver}  (VS5) a headless live host loaded into standby (GRC_ADOPT=arm) and armed
//                       through RenderStreamCapture.arm() at frame K: its viewports and proxies are
//                       adopted, not created
//   rendered/, late-rendered/  (VS5) the born and late hosts on the private gamescope (proxies
//                       bound by render-target RID), each with the same browser receiver
//
// Checks:
//   vp-live        the on leg's host and receiver exited 0, the receiver spoke render-stream/16 to the
//                  end record with every surface built (surfaces_rendered > 0, surfaces_skipped 0),
//                  its final shot equals the rendered Godot reference's last step shot within
//                  fixtures/viewport-scene/expected.json's reference regions (the file legs' vp-reference
//                  budget: the scene is static from its last step, so the final live state is that
//                  step's), and (VS5) the host's stream.gate8.viewports and adopt_stats match the
//                  file leg of the same arm and host (expected.json account: born)
//   vp-live-late, vp-live-rendered, vp-live-late-rendered  (VS5) the same for the late, rendered and
//                  late-rendered legs, each host judged against its file twin's account (late,
//                  born-rendered, late-rendered): the late hosts adopted the scene's viewports, and
//                  their shots take expected.json's reference.late classes (the popup region:
//                  subwindow residue), as vp-reference's late file legs do
//   vp-client-off  the client-off leg's receiver, built with viewports off, applied the whole stream
//                  and built no surface pass (surfaces_rendered 0, surfaces_allocated 0,
//                  surfaces_skipped > 0): the final shot differs from the on leg's in the regions
//                  surfaces feed (client_off.differs) and equals it elsewhere (client_off.same)
//
// The pure helpers are exported so scripts/test/self-test-gate8-vl.ts drives them on synthetic
// evidence.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  check,
  type G8aCheck,
  jsonl,
  readJson,
  readText,
} from "./gate8-adopt-checks";
import {
  accountProblems,
  referenceFor,
  regionDiff,
  type VpExpected,
  type VpReference,
  type VpResult,
} from "./gate8-vp-checks";

/** The live legs judged as vp-live is (a default client, viewports on): each leg's check id, the
 * expected.json account its host must report (the file leg of the same arm and host), and how it
 * differs from `on`. */
export const VL_LIVE_LEGS = [
  {
    leg: "on",
    id: "vp-live",
    account: "born",
    what: "a headless host armed at birth",
  },
  {
    leg: "late",
    id: "vp-live-late",
    account: "late",
    what: "a headless host in standby armed through RenderStreamCapture.arm() at frame K (GRC_ADOPT=arm: the scene's viewports and their proxies adopted)",
  },
  {
    leg: "rendered",
    id: "vp-live-rendered",
    account: "born-rendered",
    what: "a host armed at birth on the private gamescope (proxies bound by render-target RID)",
  },
  {
    leg: "late-rendered",
    id: "vp-live-late-rendered",
    account: "late-rendered",
    what: "a host in standby armed through the API at frame K on the private gamescope (adopted viewports, RID proxies)",
  },
] as const;

/** expected.json's `client_off`: the reference regions a `viewports: false` client must leave
 * empty (their pixels differ from the on leg's) and those it must not touch. */
export interface VlClientOff {
  doc: string;
  differs: string[];
  same: string[];
  /** pixels over the reference channel allowance a `differs` region needs to count as different */
  min_differing_px: number;
}

export type VlExpected = VpExpected & { client_off?: VlClientOff };

export interface VlSurfaces {
  viewports?: boolean;
  surfaces_rendered?: number;
  surfaces_skipped?: number;
  surfaces_unchanged?: number;
  surfaces_allocated?: number;
  surface_pixels?: number;
}

/** What a receiver leg's applied.json says (the keys the checks read). */
export interface VlApplied {
  status?: string;
  receiver?: { protocol?: string };
  end_seen?: boolean;
  live?: { gsw?: { surfaces?: VlSurfaces } } | null;
}

const num = (v: number | undefined) => (typeof v === "number" ? v : 0);

/** The problems with a live leg's run facts: exits, the protocol spoken, the end record. */
export function runProblems(
  leg: string,
  hostExit: string | undefined,
  recvExit: string | undefined,
  browser: boolean,
  applied: VlApplied | null | undefined,
): string[] {
  const problems: string[] = [];
  if (hostExit !== "0")
    problems.push(`${leg}/host: exit ${hostExit ?? "missing"}`);
  if (recvExit !== "0")
    problems.push(`${leg}/receiver: exit ${recvExit ?? "missing"}`);
  if (!browser)
    problems.push(`${leg}/receiver: no page-config.json (not a browser leg)`);
  if (applied == null) {
    problems.push(`${leg}/receiver: no applied.json`);
    return problems;
  }
  if (applied.status !== "ok")
    problems.push(`${leg}/receiver: status ${applied.status ?? "missing"}`);
  if (applied.receiver?.protocol !== "render-stream/16")
    problems.push(
      `${leg}/receiver: spoke ${applied.receiver?.protocol ?? "nothing"}, not render-stream/16`,
    );
  if (applied.end_seen !== true)
    problems.push(`${leg}/receiver: no end record seen`);
  return problems;
}

/** vp-live's surface-counter problems. */
export function liveSurfaceProblems(s: VlSurfaces | undefined): string[] {
  if (!s) return ["applied.json has no live.gsw.surfaces block"];
  const problems: string[] = [];
  if (s.viewports !== true)
    problems.push(`viewports ${s.viewports}, expected on`);
  if (num(s.surfaces_rendered) === 0)
    problems.push("no surface pass was rendered (surfaces_rendered 0)");
  if (num(s.surfaces_skipped) !== 0)
    problems.push(`surfaces_skipped ${s.surfaces_skipped} with viewports on`);
  if (num(s.surfaces_allocated) === 0)
    problems.push("no surface target was allocated (surfaces_allocated 0)");
  return problems;
}

/** vp-client-off's surface-counter problems. */
export function offSurfaceProblems(s: VlSurfaces | undefined): string[] {
  if (!s) return ["applied.json has no live.gsw.surfaces block"];
  const problems: string[] = [];
  if (s.viewports !== false)
    problems.push(`viewports ${s.viewports}, expected off`);
  if (num(s.surfaces_skipped) === 0)
    problems.push(
      "no surface was skipped (surfaces_skipped 0): the option did not reach the core",
    );
  if (num(s.surfaces_rendered) !== 0)
    problems.push(
      `surfaces_rendered ${s.surfaces_rendered} with viewports off`,
    );
  if (num(s.surfaces_allocated) !== 0)
    problems.push(
      `surfaces_allocated ${s.surfaces_allocated} with viewports off`,
    );
  return problems;
}

interface Pixels {
  data: Uint8Array;
  width: number;
  height: number;
}

/** The final shot against the reference's, per `ref` region: exact regions must hold no pixel over
 * the channel allowance. */
export function referenceShotProblems(
  leg: string,
  shot: Pixels,
  reference: Pixels,
  ref: VpReference,
): { problems: string[]; rows: ReturnType<typeof regionDiff> } {
  const problems: string[] = [];
  if (shot.width !== reference.width || shot.height !== reference.height)
    problems.push(
      `${leg}: final shot ${shot.width}x${shot.height} against the reference's ${reference.width}x${reference.height}`,
    );
  const rows = regionDiff(shot, reference, ref);
  for (const r of rows)
    if (r.class === "exact" && r.over > 0)
      problems.push(
        `${leg}: ${r.region}: ${r.over} px over ${ref.channel} (max ${r.max})`,
      );
  return { problems, rows };
}

/** The off leg's final shot against the on leg's: `differs` regions must differ (a surface that
 * was not drawn), `same` regions must not. */
export function clientOffShotProblems(
  off: Pixels,
  on: Pixels,
  ref: VpReference,
  spec: VlClientOff,
): { problems: string[]; rows: ReturnType<typeof regionDiff> } {
  const problems: string[] = [];
  if (off.width !== on.width || off.height !== on.height)
    problems.push(
      `client-off final shot ${off.width}x${off.height} against on's ${on.width}x${on.height}`,
    );
  const rows = regionDiff(off, on, ref);
  const byName = new Map(rows.map((r) => [r.region, r]));
  for (const name of [...spec.differs, ...spec.same])
    if (!byName.has(name))
      problems.push(`expected.json names no region ${name}`);
  for (const name of spec.differs) {
    const r = byName.get(name);
    if (r && r.over < spec.min_differing_px)
      problems.push(
        `${name}: only ${r.over} px differ from the on leg (at least ${spec.min_differing_px}): the surface was still drawn`,
      );
  }
  for (const name of spec.same) {
    const r = byName.get(name);
    if (r && r.over > 0)
      problems.push(
        `${name}: ${r.over} px differ from the on leg (max ${r.max}): the option changed content no surface feeds`,
      );
  }
  return { problems, rows };
}

async function leg(g: string, name: string) {
  const dir = join(g, name);
  return {
    hostExit: (await readText(join(dir, "host", "exit-code.txt")))?.trim(),
    recvExit: (await readText(join(dir, "receiver", "exit-code.txt")))?.trim(),
    browser: existsSync(join(dir, "receiver", "page-config.json")),
    applied: await readJson<VlApplied>(join(dir, "receiver", "applied.json")),
    shot: await decodePngRgba(join(dir, "receiver", "shots", "final.png")),
    hostResult: await readJson<VpResult>(
      join(dir, "host", "evidence", "result.json"),
    ),
  };
}

export async function runG8vl(
  out: string,
  ex: VlExpected,
): Promise<{ checks: G8aCheck[]; report: Record<string, unknown> }> {
  const g = join(out, "g8vl");
  const checks: G8aCheck[] = [];
  const report: Record<string, unknown> = {};
  const on = await leg(g, "on");
  const off = await leg(g, "client-off");
  const steps = jsonl<{ step: number }>(
    await readText(join(g, "reference", "capture", "steps.jsonl")),
  ).map((l) => l.step);
  const last = steps.length ? Math.max(...steps) : null;
  const ref =
    last === null
      ? undefined
      : await decodePngRgba(
          join(g, "reference", "capture", "shots", `step-${last}.png`),
        );

  // --- vp-live, and (VS5) vp-live-late, vp-live-rendered, vp-live-late-rendered ---------------
  for (const spec of VL_LIVE_LEGS) {
    const l = spec.leg === "on" ? on : await leg(g, spec.leg);
    let problems: string[] | null = null;
    let detail = "";
    if (l.applied != null || l.hostExit !== undefined) {
      problems = runProblems(
        spec.leg,
        l.hostExit,
        l.recvExit,
        l.browser,
        l.applied,
      );
      problems.push(...liveSurfaceProblems(l.applied?.live?.gsw?.surfaces));
      problems.push(
        ...accountProblems(
          l.hostResult ?? null,
          ex.account[spec.account],
          null,
          false,
        ).map((p) => `${spec.leg}/host: ${p}`),
      );
      if (!ex.reference) problems.push("expected.json has no reference block");
      else if (!l.shot)
        problems.push(`${spec.leg}/receiver/shots/final.png missing`);
      else if (!ref)
        problems.push("reference/capture has no shot of its last step");
      else {
        // VS5: a late leg judges the popup region as reference.late says (subwindow residue)
        const legRef = referenceFor(spec.leg, ex.reference, last ?? 0);
        problems.push(...legRef.problems);
        const r = referenceShotProblems(spec.leg, l.shot, ref, legRef.ref);
        problems.push(...r.problems);
        report[`${spec.id.replaceAll("-", "_")}`] = r.rows;
      }
      report[spec.leg === "on" ? "on" : spec.leg] =
        l.applied?.live?.gsw?.surfaces ?? null;
      const vp = l.hostResult?.stream?.gate8?.viewports;
      detail = `final shot against reference step ${last}; host created ${vp?.created} adopted ${vp?.adopted} rid ${vp?.proxies_bound_rid}; surfaces ${JSON.stringify(l.applied?.live?.gsw?.surfaces ?? null)}`;
    }
    checks.push(
      check(
        spec.id,
        `a /16 host served live (GRC_STREAM_VERSION=16, render-stream.16 the only subprotocol the receiver offers) from ${spec.what} to a browser GSW receiver: the host's stream.gate8.viewports and adopt_stats match expected.json's ${spec.account} account, the receiver spoke render-stream/16 to the end record with every viewport surface built, and its final shot matches the rendered Godot host's own last-step shot in every exact reference region (within ${ex.reference?.channel ?? "?"} channel step(s))`,
        problems,
        detail,
      ),
    );
  }
  // --- vp-client-off ---------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    if (off.applied != null || off.hostExit !== undefined) {
      problems = runProblems(
        "client-off",
        off.hostExit,
        off.recvExit,
        off.browser,
        off.applied,
      );
      problems.push(...offSurfaceProblems(off.applied?.live?.gsw?.surfaces));
      if (!ex.reference || !ex.client_off)
        problems.push("expected.json has no reference or client_off block");
      else if (!off.shot || !on.shot)
        problems.push("a final shot is missing (client-off or on)");
      else {
        const r = clientOffShotProblems(
          off.shot,
          on.shot,
          ex.reference,
          ex.client_off,
        );
        problems.push(...r.problems);
        report.vp_client_off = r.rows;
      }
      report.client_off = off.applied?.live?.gsw?.surfaces ?? null;
      detail = `surfaces ${JSON.stringify(off.applied?.live?.gsw?.surfaces ?? null)}`;
    }
    checks.push(
      check(
        "vp-client-off",
        "the same live stream to a receiver built with viewports off (the client's `viewports: false`, RS_RECEIVER_VIEWPORTS=off): the whole stream applies, no surface pass is built or allocated and the skipped ones are counted (surfaces_skipped), viewport textures draw transparent so the regions surfaces feed differ from the on leg's final shot, and everything else is the same",
        problems,
        detail,
      ),
    );
  }
  return { checks, report };
}
