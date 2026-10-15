// Gate 7 phone-target leg vocabulary (G7d; protocol/gate7-design.md Q13d "Legs (`g7-dev`)", Q13e
// "Arms"). One pure function decides which legs a run selects, so the runner, the checker and
// self-test-device-harness.ts agree on it:
//   - `dev-*` arms run only with `--env device --device <id>` (D28: "Runs without `--env device`
//     never select `g7-dev`'s device arms"), and only that phone's legs;
//   - every device leg has an unattended desktop control arm `ctl-<same name>` (report-only);
//   - g7-bench's arms: native-bench-<input> (desktop native, headless), ctl-bench-<input>-<kind>
//     (desktop Chromium) and dev-bench-<input>-<kind>-<id> (the phone).
// Live legs are planned with what they still need: every dev/ctl rate, soak, startup and headroom
// leg needs the browser receivers (G7a, G7e), the /7 listener (G7n) and live browser legs (G7l);
// window 2 needs G7q, soak and startup need G7k. G7v runs them. Until then they are `not-run`.

export type Workload = "pace" | "scene" | "hd";
export type Kind = "web" | "gsw";

export interface PlannedLeg {
  name: string;
  arm: "dev" | "ctl" | "native";
  device: string | null;
  workload: Workload | null;
  kind: Kind | "native" | null;
  required: boolean;
  report_only: boolean;
  /** Increments that must land before the leg can run (empty: runnable now). */
  needs: string[];
  /** Why it runs only sometimes (a precondition the plan cannot decide). */
  condition: string | null;
}

export interface DevicePlanEntry {
  required_workloads: string[];
  stretch_workloads: string[];
  panel_modes_hz: number[];
  predicted_tp_ms: number;
}

type PlannedBase = Omit<PlannedLeg, "arm" | "name"> & { base: string };

const LIVE_NEEDS: Record<Kind, string[]> = {
  web: ["G7e", "G7n", "G7l"],
  gsw: ["G7a", "G7n", "G7l"],
};

function devLegs(id: string, entry: DevicePlanEntry): PlannedBase[] {
  const out: PlannedBase[] = [];
  const isRequired = (w: Workload) => entry.required_workloads.includes(w);
  for (const w of ["pace", "scene", "hd"] as Workload[])
    for (const win of [1, 2])
      for (const kind of ["web", "gsw"] as Kind[])
        out.push({
          base: `dev-${w}-w${win}-${kind}`,
          device: id,
          workload: w,
          kind,
          required: isRequired(w),
          report_only: false,
          needs: [...LIVE_NEEDS[kind], ...(win === 2 ? ["G7q"] : [])],
          condition: null,
        });
  for (const w of ["pace", "scene", "hd"] as Workload[])
    out.push({
      base: `dev-gpu-headroom-${w}-gsw`,
      device: id,
      workload: w,
      kind: "gsw",
      required: isRequired(w),
      report_only: false,
      needs: [...LIVE_NEEDS.gsw],
      condition: null,
    });
  // The soak runs each phone's heaviest REQUIRED workload: scene on the g31, hd on the g86.
  const soakWorkload: Workload = isRequired("hd") ? "hd" : "scene";
  for (const kind of ["web", "gsw"] as Kind[]) {
    out.push({
      base: `dev-soak-${kind}`,
      device: id,
      workload: soakWorkload,
      kind,
      required: true,
      report_only: false,
      needs: [...LIVE_NEEDS[kind], "G7k"],
      condition: null,
    });
    if (entry.stretch_workloads.includes("hd"))
      out.push({
        base: `dev-soak-hd-${kind}`,
        device: id,
        workload: "hd",
        kind,
        required: false,
        report_only: true,
        needs: [...LIVE_NEEDS[kind], "G7k"],
        condition: `only if ${kind} passed this phone's hd rate leg`,
      });
  }
  for (const temp of ["warm", "cold"])
    for (const kind of ["web", "gsw"] as Kind[])
      out.push({
        base: `dev-startup-${temp}-${kind}`,
        device: id,
        workload: "scene",
        kind,
        required: temp === "warm",
        report_only: temp === "cold",
        needs: [...LIVE_NEEDS[kind], "G7k"],
        condition: null,
      });
  out.push({
    base: "dev-maxfps60-scene-w1-web",
    device: id,
    workload: "scene",
    kind: "web",
    required: false,
    report_only: true,
    needs: [...LIVE_NEEDS.web],
    condition: null,
  });
  // A phone with one display mode (the g31) has no dev-panel legs; the g86's run only if the user
  // switches its refresh setting (Q13a: other settings are report-only and only the user changes them).
  const defaultHz = Math.round(1000 / entry.predicted_tp_ms);
  for (const hz of entry.panel_modes_hz.filter((m) => m !== defaultHz))
    for (const win of [1, 2])
      for (const kind of ["web", "gsw"] as Kind[])
        out.push({
          base: `dev-panel-${hz}-scene-w${win}-${kind}`,
          device: id,
          workload: "scene",
          kind,
          required: false,
          report_only: true,
          needs: [...LIVE_NEEDS[kind], ...(win === 2 ? ["G7q"] : [])],
          condition: `only if the user switches the panel to ${hz} Hz`,
        });
  return out;
}

/**
 * The g7-dev plan. `deviceId` null (no `--env device`): only the `ctl-` control arms of the
 * baseline phone's legs, report-only and unattended. With a device: that device's `dev-` legs and
 * their `ctl-` arms.
 */
export function planGate7Dev(
  deviceId: string | null,
  table: Record<string, DevicePlanEntry>,
): PlannedLeg[] {
  const id = deviceId ?? "g31";
  const entry = table[id];
  if (!entry) throw new Error(`no device ${id} in the table`);
  const legs: PlannedLeg[] = [];
  for (const base of devLegs(id, entry)) {
    const { base: name, ...rest } = base;
    if (deviceId !== null) legs.push({ ...rest, name, arm: "dev" });
    legs.push({
      ...rest,
      name: `ctl-${name}`,
      arm: "ctl",
      device: null,
      required: false,
      report_only: true,
    });
  }
  return legs;
}

/** The g7-bench plan for `inputs` (Q13e "Arms"). The web arm needs G7e. */
export function planGate7Bench(
  deviceId: string | null,
  inputs: readonly string[],
): PlannedLeg[] {
  const legs: PlannedLeg[] = [];
  for (const input of inputs) {
    if (deviceId === null) {
      legs.push({
        name: `native-bench-${input}`,
        arm: "native",
        device: null,
        workload: null,
        kind: "native",
        required: false,
        report_only: true,
        needs: [],
        condition: null,
      });
      for (const kind of ["gsw", "web"] as Kind[])
        legs.push({
          name: `ctl-bench-${input}-${kind}`,
          arm: "ctl",
          device: null,
          workload: null,
          kind,
          required: false,
          report_only: true,
          needs: kind === "web" ? ["G7e"] : [],
          condition: null,
        });
    } else {
      for (const kind of ["gsw", "web"] as Kind[])
        legs.push({
          name: `dev-bench-${input}-${kind}-${deviceId}`,
          arm: "dev",
          device: deviceId,
          workload: null,
          kind,
          required: false,
          report_only: false,
          needs: kind === "web" ? ["G7e"] : [],
          condition: null,
        });
    }
  }
  return legs;
}
