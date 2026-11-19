import type { ProgramHost } from "../src/programs";

/** The wasm boundary's stable pending snapshot, including held entries after new ones. */
export function programHost(count: number, onDefine: () => void = () => {}) {
  const states = Array.from({ length: count }, () => "pending");
  let snapshot: number[] = [];
  const at = (i: number) => snapshot[i];
  const host = {
    states,
    pending_shaders: () => {
      snapshot = [
        ...states.flatMap((s, i) => (s === "pending" ? [i] : [])),
        ...states.flatMap((s, i) => (s === "held" ? [i] : [])),
      ];
      return snapshot.length;
    },
    pending_hash: (i: number) => String(at(i)),
    pending_shader_id: (i: number) => BigInt(at(i)),
    pending_withheld: () => false,
    pending_code: () =>
      "shader_type canvas_item; void fragment() { COLOR = vec4(1.0); }",
    alloc_payload: () => 0,
    provide_library: () => 0,
    hold_program: (i: number) => {
      states[at(i)] = "held";
      return 0;
    },
    define_program: (i: number) => {
      states[at(i)] = "linking";
      onDefine();
      return 0;
    },
    refuse_program: (i: number) => {
      states[at(i)] = "refused";
      return 0;
    },
    error: () => "fake error",
    live_reset: () => states.fill("reset"),
    poll_programs: () => {
      let settled = 0;
      for (let i = 0; i < states.length && settled < 3; i++) {
        if (states[i] !== "linking") continue;
        states[i] = "ready";
        settled++;
      }
      return settled;
    },
  } satisfies ProgramHost & Record<string, unknown>;
  return host;
}
