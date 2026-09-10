import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

const runtimes = vi.hoisted(() => {
  const shaderReconcile = vi.fn();
  const shaderDispose = vi.fn();
  const particleReconcile = vi.fn();
  const particleDispose = vi.fn();
  return {
    shaderCreate: vi.fn(() => ({
      reconcile: shaderReconcile,
      dispose: shaderDispose,
    })),
    particleCreate: vi.fn(() => ({
      reconcile: particleReconcile,
      dispose: particleDispose,
    })),
    shaderReconcile,
    shaderDispose,
    particleReconcile,
    particleDispose,
  };
});

vi.mock("../../html/src/particles/runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../html/src/particles/runtime")
  >()),
  createParticleRuntime: runtimes.particleCreate,
}));
vi.mock("../../html/src/webgl/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../html/src/webgl/runtime")>()),
  createWebglShaderRuntime: runtimes.shaderCreate,
}));

import { GodotSceneView } from "../src/index";

function scene(text: string) {
  return parseGodotTextScene(`
[gd_scene load_steps=1 format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Label" type="Label" parent="."]
offset_right = 200
offset_bottom = 40
text = "${text}"
`);
}

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
}

describe("GodotSceneView live runtime lifecycle", () => {
  beforeEach(() => {
    runtimes.shaderCreate.mockClear();
    runtimes.particleCreate.mockClear();
    runtimes.shaderReconcile.mockClear();
    runtimes.particleReconcile.mockClear();
    runtimes.shaderDispose.mockClear();
    runtimes.particleDispose.mockClear();
  });

  it("reconciles persistent runtimes across model updates and rebuilds only for option changes", async () => {
    const wrapper = mount(GodotSceneView, {
      props: {
        scene: scene("first"),
        options: { enableWebglShaders: true, enableParticles: true },
      },
    });
    await settle();

    expect(runtimes.shaderCreate).toHaveBeenCalledTimes(1);
    expect(runtimes.particleCreate).toHaveBeenCalledTimes(1);
    const initialShaderReconciles = runtimes.shaderReconcile.mock.calls.length;
    const initialParticleReconciles =
      runtimes.particleReconcile.mock.calls.length;
    expect(initialShaderReconciles).toBeGreaterThan(0);
    expect(initialParticleReconciles).toBeGreaterThan(0);

    await wrapper.setProps({ scene: scene("second") });
    await settle();

    expect(runtimes.shaderCreate).toHaveBeenCalledTimes(1);
    expect(runtimes.particleCreate).toHaveBeenCalledTimes(1);
    expect(runtimes.shaderReconcile).toHaveBeenCalledTimes(
      initialShaderReconciles + 1,
    );
    expect(runtimes.particleReconcile).toHaveBeenCalledTimes(
      initialParticleReconciles + 1,
    );

    await wrapper.setProps({
      options: {
        enableWebglShaders: true,
        enableParticles: true,
        shaderFps: 30,
      },
    });
    await settle();

    expect(runtimes.shaderDispose).toHaveBeenCalledTimes(1);
    expect(runtimes.particleDispose).toHaveBeenCalledTimes(0);
    expect(runtimes.shaderCreate).toHaveBeenCalledTimes(2);
    expect(runtimes.particleCreate).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(runtimes.shaderDispose).toHaveBeenCalledTimes(2);
    expect(runtimes.particleDispose).toHaveBeenCalledTimes(1);
  });
});
