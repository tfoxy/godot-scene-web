import { type Calibration, callbackRate, type Segment } from "./probe";

export interface CalibrationOptions {
  /** Record a two-second, every-callback run using the supplied iteration count. */
  sample(iterations: number): Promise<Segment>;
  allowMinimumWorkloadTooSlow?: boolean;
}

/** Full-canvas fragment load in a context owned exclusively by the caller. */
export function createGpuLoad(gl: WebGL2RenderingContext) {
  function shader(type: number, source: string): WebGLShader {
    const result = gl.createShader(type);
    if (!result) throw new Error("pace-model: createShader failed");
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS))
      throw new Error(`pace-model: shader: ${gl.getShaderInfoLog(result)}`);
    return result;
  }

  const program = gl.createProgram();
  if (!program) throw new Error("pace-model: createProgram failed");
  gl.attachShader(
    program,
    shader(
      gl.VERTEX_SHADER,
      `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`,
    ),
  );
  gl.attachShader(
    program,
    shader(
      gl.FRAGMENT_SHADER,
      `#version 300 es
precision highp float;
uniform int iterations;
uniform float seed;
out vec4 color;
void main() {
  vec3 p = vec3(gl_FragCoord.xy / vec2(1280.0, 720.0), seed);
  for (int i = 0; i < iterations; i++) {
    p = fract(sin(p.zxy * 1.013 + p.yzx * 0.731 + vec3(0.13, 0.27, 0.39)) * 1.719);
  }
  color = vec4(p, 1.0);
}`,
    ),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`pace-model: link: ${gl.getProgramInfoLog(program)}`);
  gl.useProgram(program);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  const iterationsLocation = gl.getUniformLocation(program, "iterations");
  const seedLocation = gl.getUniformLocation(program, "seed");
  if (!iterationsLocation || !seedLocation)
    throw new Error("pace-model: missing uniforms");
  function draw(iterations: number, timestampMs: number) {
    gl.uniform1i(iterationsLocation, iterations);
    gl.uniform1f(seedLocation, (timestampMs % 1000) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  async function calibrate(
    targetHz: number,
    options: CalibrationOptions,
  ): Promise<Calibration> {
    if (!Number.isFinite(targetHz) || targetHz <= 0)
      throw new Error("pace-model: invalid targetHz");
    const delay = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const samples: Segment[] = [];
    let lower = 0;
    let upper = 0;
    let best = 1;
    let bestRate = 0;
    let bestError = Infinity;
    let baseline = 0;
    let minimum = Infinity;
    let limitation: Calibration["limitation"];
    let iterations = 1;
    // Exponential bracketing, followed by integer bisection. Every candidate is
    // drawn on every callback for a real two seconds; there is no CPU throttling.
    for (let attempt = 0; attempt < 24; attempt++) {
      await delay(500);
      const s = await options.sample(iterations);
      samples.push(s);
      const hz = callbackRate(s);
      if (hz === 0)
        throw new Error("pace-model: calibration received no callbacks");
      if (attempt === 0) baseline = hz;
      minimum = Math.min(minimum, hz);
      const error = Math.abs(hz / targetHz - 1);
      if (error < bestError) {
        bestError = error;
        best = iterations;
        bestRate = hz;
      }
      if (error <= 0.05) break;
      if (
        options.allowMinimumWorkloadTooSlow &&
        iterations === 1 &&
        hz < targetHz * 0.95
      ) {
        limitation = "minimum-workload-too-slow";
        break;
      }
      if (hz > targetHz) lower = iterations;
      else upper = iterations;
      if (upper && upper - lower <= 1) break;
      const next = upper ? Math.floor((lower + upper) / 2) : iterations * 2;
      if (next > 8192) break;
      iterations = next;
    }
    iterations = best;
    return {
      targetHz,
      reachedHz: bestRate,
      iterations,
      calibrated: bestError <= 0.05,
      backpressure: minimum < baseline * 0.92,
      ...(limitation ? { limitation } : {}),
      samples,
    };
  }

  return { draw, calibrate };
}
