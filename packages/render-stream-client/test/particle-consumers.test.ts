// @vitest-environment node
import type { GodotProcessMaterial } from "@godot-scene-web/effects/particles";
import { transformSync } from "esbuild";
import { expect, it } from "vitest";
import probe from "../../../experiments/render-stream/web/client-options-probe.ts?raw";
import live from "../../../experiments/render-stream/web/gsw-receiver/live.ts?raw";
import file from "../../../experiments/render-stream/web/gsw-receiver/main.ts?raw";
import { GswParticles, type ParticlesHost } from "../src/particles";

// Execute the consumers' own calls and the probe's wrapper: a direct particles unit test
// cannot catch a consumer dropping the arena pointer or memory at this boundary.
const consumers = [
  { name: "file receiver", source: file },
  { name: "live receiver", source: live },
  { name: "client options probe", source: probe },
];

it.each(
  consumers.flatMap((c) => [
    { ...c, late: false },
    { ...c, late: true },
  ]),
)("$name copies sidecar curves before memory grows (late: $late)", ({
  source,
  late,
}) => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const values = new Float32Array([-0, 0, 0.5, 1]);
  const ptr = 256;
  let available = !late;
  const g: ParticlesHost = {
    particles_sync: () => {
      memory.grow(1);
      new Float32Array(memory.buffer, ptr, values.length).set(values);
      return JSON.stringify({
        ids: [],
        emitters: [],
        materials: available
          ? [
              {
                id: 20,
                version: 1,
                builtin: {
                  emission_shape: "point",
                  particle_flags: [],
                  turbulence: false,
                },
                uniforms: {},
                curves: {
                  scale_curve: { width: 1, height: 1, offset: 0, length: 4 },
                },
              },
            ]
          : [],
      });
    },
    particles_curves_ptr() {
      expect(this).toBe(g);
      return ptr;
    },
    shader_time: () => {
      new Float32Array(memory.buffer, ptr, values.length).fill(99);
      memory.grow(1);
      return 0;
    },
    particles_set: () => {},
  };
  const wrapper = source.match(/const host = (\{[\s\S]*?\n {2}\});/);
  const host = wrapper
    ? new Function(
        "g",
        "uploads",
        `${
          transformSync(`const host = ${wrapper[1]};`, {
            loader: "ts",
          }).code
        }\nreturn host;`,
      )(g, [])
    : g;
  const call = source.match(/(?:this\.)?particles\.step\([\s\S]*?\);/)?.[0];
  expect(call).toBeDefined();
  const step = new Function(
    "particles",
    "g",
    "mem",
    "memory",
    "host",
    "message",
    call ?? "",
  );
  const particles = new GswParticles();
  const run = () =>
    step.call(
      { particles, mem: memory },
      particles,
      g,
      memory,
      memory,
      host,
      wrapper ? g.particles_sync() : undefined,
    );
  try {
    if (late) {
      run();
      available = true;
    }
    run();
    const materials = Reflect.get(particles, "materials") as Map<
      number,
      { material: GodotProcessMaterial }
    >;
    const curve = materials.get(20)?.material.curves.scale_curve;
    expect(curve).toBeDefined();
    expect(Array.from(new Uint32Array(curve!.data.buffer))).toEqual([
      0x80000000, 0, 0x3f000000, 0x3f800000,
    ]);
    expect(curve!.data.buffer).not.toBe(memory.buffer);
  } finally {
    particles.dispose();
  }
});
