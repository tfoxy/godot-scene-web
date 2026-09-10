import type { ShaderUniform } from "@godot-scene-web/effects/shaders";

/** Allocate the shared clip-space quad used by full-surface shader draws. */
export function createWebglFullscreenQuad(
  gl: WebGL2RenderingContext,
): WebGLBuffer | null {
  const quad = gl.createBuffer();
  if (!quad) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  return quad;
}

export function createWebglTexture(
  gl: WebGL2RenderingContext,
): WebGLTexture | null {
  return gl.createTexture();
}

function setTextureSampling(
  gl: WebGL2RenderingContext,
  repeat: boolean,
  nearest = false,
): void {
  const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  const filter = nearest ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
}

/** Upload bytes, an image, or a canvas with Godot's top-left UV convention. */
export function uploadWebglTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  source: TexImageSource | Uint8Array,
  width?: number,
  height?: number,
  opts: { repeat?: boolean; nearest?: boolean } = {},
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (source instanceof Uint8Array) {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width ?? 1,
      height ?? 1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    );
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }
  setTextureSampling(gl, opts.repeat === true, opts.nearest === true);
}

export function createWebglPlaceholderTexture(
  gl: WebGL2RenderingContext,
  repeat: boolean,
): WebGLTexture | null {
  const texture = createWebglTexture(gl);
  if (texture)
    uploadWebglTexture(gl, texture, new Uint8Array([0, 0, 0, 0]), 1, 1, {
      repeat,
    });
  return texture;
}

// Program status queries can stall on driver compilation. This DOM-free layer owns the
// KHR_parallel_shader_compile completion probe and a shared poll for every borrowed context.
export interface PendingProgram {
  ready(): boolean;
  finish(): WebGLProgram | null;
}

const COMPILE_POLL_MS = 1;
const COMPILE_MAX_WAIT_MS = 3000;
const parallelCompileExts = new WeakMap<
  WebGL2RenderingContext,
  { COMPLETION_STATUS_KHR: number } | null
>();

function parallelCompileExt(
  gl: WebGL2RenderingContext,
): { COMPLETION_STATUS_KHR: number } | null {
  const cached = parallelCompileExts.get(gl);
  if (cached !== undefined) return cached;
  let ext: { COMPLETION_STATUS_KHR: number } | null = null;
  try {
    const found = gl.getExtension("KHR_parallel_shader_compile") as {
      COMPLETION_STATUS_KHR?: number;
    } | null;
    ext =
      found && typeof found.COMPLETION_STATUS_KHR === "number"
        ? { COMPLETION_STATUS_KHR: found.COMPLETION_STATUS_KHR }
        : null;
  } catch {
    ext = null;
  }
  parallelCompileExts.set(gl, ext);
  return ext;
}

const FAILED_PROGRAM: PendingProgram = {
  ready: () => true,
  finish: () => null,
};

/** Kick compilation and linking without synchronously asking the driver for status. */
export function startProgram(
  gl: WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
  beforeLink?: (program: WebGLProgram) => void,
): PendingProgram {
  const vs = startShader(gl, gl.VERTEX_SHADER, vertexSrc);
  const fs = startShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return FAILED_PROGRAM;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return FAILED_PROGRAM;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  beforeLink?.(program);
  gl.linkProgram(program);
  const ext = parallelCompileExt(gl);
  let completed = false;
  return {
    ready(): boolean {
      if (completed || !ext) return true;
      completed =
        gl.getProgramParameter(program, ext.COMPLETION_STATUS_KHR) === true;
      return completed;
    },
    finish(): WebGLProgram | null {
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return program;
      }
      let compileFailed = false;
      for (const shader of [vs, fs]) {
        if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) continue;
        compileFailed = true;
        console.warn(
          "[gsw webgl] shader compile failed:",
          gl.getShaderInfoLog(shader),
        );
      }
      if (!compileFailed)
        console.warn(
          "[gsw webgl] program link failed:",
          gl.getProgramInfoLog(program),
        );
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(program);
      return null;
    },
  };
}

/** Compile and link synchronously for callers that cannot yield. */
export function compileProgram(
  gl: WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
  beforeLink?: (program: WebGLProgram) => void,
): WebGLProgram | null {
  return startProgram(gl, vertexSrc, fragmentSrc, beforeLink).finish();
}

interface CompileWaiter {
  pending: PendingProgram;
  deadline: number;
  wake: () => void;
}
const compileWaiters = new Set<CompileWaiter>();
let compilePollTimer: ReturnType<typeof setTimeout> | null = null;
function performanceNow(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : 0;
}
function pollCompiles(): void {
  compilePollTimer = null;
  const now = performanceNow();
  for (const waiter of [...compileWaiters]) {
    if (!waiter.pending.ready() && now < waiter.deadline) continue;
    compileWaiters.delete(waiter);
    waiter.wake();
  }
  if (compileWaiters.size > 0) scheduleCompilePoll();
}
function scheduleCompilePoll(): void {
  if (compilePollTimer === null)
    compilePollTimer = setTimeout(pollCompiles, COMPILE_POLL_MS);
}

/** Finish when the parallel-compile extension says its status query will not block. */
export async function compileProgramAsync(
  gl: WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
  beforeLink?: (program: WebGLProgram) => void,
): Promise<WebGLProgram | null> {
  const pending = startProgram(gl, vertexSrc, fragmentSrc, beforeLink);
  if (!pending.ready() && typeof setTimeout === "function") {
    await new Promise<void>((wake) => {
      compileWaiters.add({
        pending,
        deadline: performanceNow() + COMPILE_MAX_WAIT_MS,
        wake,
      });
      scheduleCompilePoll();
    });
  }
  return pending.finish();
}

/** Fully precomputed GPU frame. HTML adapters calculate DOM geometry/captures first. */
export interface WebglGodotShaderFrame {
  readonly program: WebGLProgram;
  readonly locations: ReadonlyMap<string, WebGLUniformLocation | null>;
  readonly uniforms: readonly ShaderUniform[];
  readonly quad: WebGLBuffer;
  readonly width: number;
  readonly height: number;
  readonly texture: WebGLTexture | null;
  readonly time?: number;
  readonly texturePixelSize?: readonly [number, number];
  readonly modulate: readonly [number, number, number, number];
  readonly uvFit: readonly [number, number];
  readonly uvWindow: readonly [number, number, number, number];
  readonly screenOrigin?: readonly [number, number];
  readonly screenSize?: readonly [number, number];
  readonly screenTexture?: WebGLTexture;
  readonly screenTextureUnit?: number;
  readonly screenPixelSize?: readonly [number, number];
  readonly samplers: readonly {
    name: string;
    unit: number;
    texture: WebGLTexture | null;
  }[];
  readonly params: Readonly<Record<string, number | readonly number[]>>;
  readonly paramKinds: Readonly<Record<string, string>>;
}

/** Execute one Godot shader frame in a borrowed context; no DOM, scheduling, or capture work. */
export function drawGodotWebglShaderFrame(
  gl: WebGL2RenderingContext,
  frame: WebglGodotShaderFrame,
): void {
  const loc = (name: string) => frame.locations.get(name) ?? null;
  const one = (name: string, value: number) => {
    const l = loc(name);
    if (l) gl.uniform1f(l, value);
  };
  const two = (name: string, value: readonly number[]) => {
    const l = loc(name);
    if (l) gl.uniform2f(l, value[0] ?? 0, value[1] ?? 0);
  };
  const four = (name: string, value: readonly number[]) => {
    const l = loc(name);
    if (l)
      gl.uniform4f(
        l,
        value[0] ?? 0,
        value[1] ?? 0,
        value[2] ?? 0,
        value[3] ?? 0,
      );
  };
  gl.viewport(0, 0, frame.width, frame.height);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.useProgram(frame.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, frame.quad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, frame.texture);
  {
    const l = loc("TEXTURE");
    if (l) gl.uniform1i(l, 0);
  }
  if (frame.time !== undefined) one("TIME", frame.time);
  if (frame.texturePixelSize) two("TEXTURE_PIXEL_SIZE", frame.texturePixelSize);
  four("MODULATE", frame.modulate);
  two("_godot_uv_fit", frame.uvFit);
  four("_godot_uv_window", frame.uvWindow);
  if (frame.screenOrigin) two("_godot_screen_origin", frame.screenOrigin);
  if (frame.screenSize) two("_godot_screen_size", frame.screenSize);
  if (frame.screenTexture) {
    const unit = frame.screenTextureUnit ?? 1;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, frame.screenTexture);
    const l = loc("SCREEN_TEXTURE");
    if (l) gl.uniform1i(l, unit);
  }
  if (frame.screenPixelSize) two("SCREEN_PIXEL_SIZE", frame.screenPixelSize);
  for (const sampler of frame.samplers) {
    gl.activeTexture(gl.TEXTURE0 + sampler.unit);
    gl.bindTexture(gl.TEXTURE_2D, sampler.texture);
    const l = loc(sampler.name);
    if (l) gl.uniform1i(l, sampler.unit);
  }
  for (const uniform of frame.uniforms)
    uploadGodotShaderUniform(
      gl,
      loc(uniform.name),
      uniform,
      frame.params[uniform.name],
      frame.paramKinds[uniform.name],
    );
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/** Exact Godot scalar/vector/array upload rules. Callers retain their own binding model. */
export function uploadGodotShaderUniform(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | null,
  uniform: ShaderUniform,
  raw: number | readonly number[] | undefined,
  paramKind?: string,
): void {
  if (!location) return;
  const value = raw ?? uniform.default;
  const values = Array.isArray(value) ? [...value] : [];
  const pad = (length: number) => {
    const out = values.slice(0, length);
    while (out.length < length) out.push(0);
    return out;
  };
  if (uniform.arrayLength) {
    const n = uniform.arrayLength;
    if (uniform.type === "float")
      gl.uniform1fv(location, new Float32Array(pad(n)));
    else if (uniform.type === "int" || uniform.type === "bool")
      gl.uniform1iv(location, new Int32Array(pad(n).map(Math.round)));
    else if (uniform.type === "vec2")
      gl.uniform2fv(location, new Float32Array(pad(n * 2)));
    else if (uniform.type === "vec3") {
      const flat =
        paramKind === "PackedColorArray" && values.length % 4 === 0
          ? values.filter((_, i) => i % 4 !== 3)
          : values;
      while (flat.length < n * 3) flat.push(0);
      gl.uniform3fv(location, new Float32Array(flat.slice(0, n * 3)));
    } else if (uniform.type === "vec4")
      gl.uniform4fv(location, new Float32Array(pad(n * 4)));
    return;
  }
  if (uniform.type === "float")
    gl.uniform1f(location, typeof value === "number" ? value : 0);
  else if (uniform.type === "int" || uniform.type === "bool")
    gl.uniform1i(location, typeof value === "number" ? Math.round(value) : 0);
  else if (uniform.type === "vec2")
    gl.uniform2f(location, values[0] ?? 0, values[1] ?? 0);
  else if (uniform.type === "vec3")
    gl.uniform3f(location, values[0] ?? 0, values[1] ?? 0, values[2] ?? 0);
  else if (uniform.type === "vec4")
    gl.uniform4f(
      location,
      values[0] ?? 0,
      values[1] ?? 0,
      values[2] ?? 0,
      values[3] ?? 0,
    );
}

function startShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

/** Clear a supplied framebuffer's draw region; callers control its lifetime and binding. */
export function clearWebglSurface(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  scissorToViewport = false,
): void {
  gl.viewport(0, 0, width, height);
  if (scissorToViewport) {
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, width, height);
  }
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (scissorToViewport) gl.disable(gl.SCISSOR_TEST);
}

/** Release an owned texture. Borrowed texture handles must not be passed here. */
export function deleteWebglTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture | null,
): void {
  gl.deleteTexture(texture);
}
