import { describe, expect, it, vi } from "vitest";
import { uploadGodotShaderUniform } from "../src/webgl";

describe("Godot shader uniform uploads", () => {
  it("drops PackedColorArray alpha before padding the actual GPU vec3 upload", () => {
    const uniform3fv = vi.fn();
    const gl = { uniform3fv } as unknown as WebGL2RenderingContext;
    const location = {} as WebGLUniformLocation;
    uploadGodotShaderUniform(
      gl,
      location,
      { name: "colors", type: "vec3", arrayLength: 8 },
      [
        0.54, 0.55, 0.98, 1, 0.25, 0.23, 0.85, 1, 0.31, 0.29, 0.93, 1, 0.84,
        0.87, 0.98, 1,
      ],
      "PackedColorArray",
    );
    expect(uniform3fv).toHaveBeenCalledExactlyOnceWith(
      location,
      new Float32Array([
        0.54, 0.55, 0.98, 0.25, 0.23, 0.85, 0.31, 0.29, 0.93, 0.84, 0.87, 0.98,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]),
    );
  });
});
