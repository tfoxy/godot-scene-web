import { afterEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({
  shaders: vi.fn(() => ({ reconcile: vi.fn(), dispose: vi.fn() })),
  particles: vi.fn(() => ({ reconcile: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("../src/webgl/runtime", () => ({
  createWebglShaderRuntime: factories.shaders,
}));
vi.mock("../src/particles/runtime", () => ({
  createParticleRuntime: factories.particles,
}));

import { createHtmlEffectsHost } from "../src/runtime";

afterEach(() => vi.clearAllMocks());

describe("shared DOM effect owner", () => {
  it("preserves the other family when a host changes settings or turns one off", () => {
    const stage = document.createElement("div");
    const host = createHtmlEffectsHost(stage, {
      shaderOptions: { enableWebglShaders: true, renderScale: 0.5 },
      particleOptions: { enableParticles: true, renderScale: 1 },
    });
    const firstShader = factories.shaders.mock.results[0].value;
    const particle = factories.particles.mock.results[0].value;
    host.reconcile();
    host.reconcile();
    expect(factories.shaders).toHaveBeenCalledTimes(1);
    expect(factories.particles).toHaveBeenCalledTimes(1);
    expect(firstShader.reconcile).toHaveBeenCalledTimes(2);
    host.updateOptions({
      shaderOptions: { enableWebglShaders: true, renderScale: 0.25 },
      particleOptions: { enableParticles: true, renderScale: 1 },
    });
    expect(firstShader.dispose).toHaveBeenCalledOnce();
    expect(particle.dispose).not.toHaveBeenCalled();
    expect(host.particles).toBe(particle);
    const secondShader = factories.shaders.mock.results[1].value;
    host.updateOptions({
      shaderOptions: { enableWebglShaders: false },
      particleOptions: { enableParticles: true, renderScale: 1 },
    });
    expect(secondShader.dispose).toHaveBeenCalledOnce();
    expect(host.shaders).toBeNull();
    expect(host.particles).toBe(particle);
    host.dispose();
    host.dispose();
    host.reconcile();
    host.updateOptions({ enableParticles: true });
    expect(particle.dispose).toHaveBeenCalledOnce();
    expect(factories.particles).toHaveBeenCalledOnce();
  });

  it("leaves externally owned bindings to their host", () => {
    const host = createHtmlEffectsHost(document.createElement("div"), {
      enableParticles: true,
      enableWebglShaders: true,
      externalRuntimes: true,
    });
    host.reconcile();
    host.dispose();
    expect(factories.shaders).not.toHaveBeenCalled();
    expect(factories.particles).not.toHaveBeenCalled();
  });
});
