import {
  BatchableSprite, Buffer, BufferUsage, DefaultBatcher, ExtensionType, Geometry,
  NineSliceSprite, NineSliceSpriteGpuData, NineSliceGeometry, Shader, Sprite, colorBitGl,
  compileHighShaderGlProgram, generateTextureBatchBitGl, getBatchSamplersUniformGroup,
  roundPixelsBitGl, type InstructionSet, type Renderer, type DefaultBatchableMeshElement,
  type DefaultBatchableQuadElement,
} from "pixi.js";

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;
const matrices = new WeakMap<Sprite | NineSliceSprite, readonly number[]>();

/** These display types retain Pixi's sprite/nine-slice geometry and painter order. */
export class MatrixSprite extends Sprite {
  override readonly renderPipeId = "matrixSprite";
  setInlineMatrix(enabled: boolean, matrix: ArrayLike<number>): void {
    storeMatrix(this, enabled, matrix);
    this.onViewUpdate();
  }
}
export class MatrixNineSliceSprite extends NineSliceSprite {
  override readonly renderPipeId = "matrixNineSliceSprite";
  setInlineMatrix(enabled: boolean, matrix: ArrayLike<number>): void {
    storeMatrix(this, enabled, matrix);
    this.onViewUpdate();
  }
}

function storeMatrix(sprite: MatrixSprite | MatrixNineSliceSprite,
  enabled: boolean, matrix: ArrayLike<number>): void {
  if (!enabled) { matrices.delete(sprite); return; }
  if (matrix.length < 9) throw new Error("invalid inline color matrix");
  const values = Array.from({ length: 9 }, (_, i) => matrix[i]);
  if (!values.every(Number.isFinite)) throw new Error("invalid inline color matrix");
  if (values.every((value, i) => value === IDENTITY[i])) matrices.delete(sprite);
  else matrices.set(sprite, values);
}

type MatrixElement = (DefaultBatchableQuadElement | DefaultBatchableMeshElement) & {
  readonly renderable: Sprite | NineSliceSprite;
};

const matrixBit = {
  name: "inline-color-matrix",
  vertex: {
    header: `
      in vec3 aMatrix0; in vec3 aMatrix1; in vec3 aMatrix2;
      out vec3 vMatrix0; out vec3 vMatrix1; out vec3 vMatrix2;
    `,
    main: `vMatrix0 = aMatrix0; vMatrix1 = aMatrix1; vMatrix2 = aMatrix2;`,
  },
  fragment: {
    header: `in vec3 vMatrix0; in vec3 vMatrix1; in vec3 vMatrix2;`,
    main: `
      vec3 straightColor = outColor.a > 0.0 ? outColor.rgb / outColor.a : vec3(0.0);
      outColor.rgb = clamp(vec3(dot(vMatrix0, straightColor),
                                 dot(vMatrix1, straightColor),
                                 dot(vMatrix2, straightColor)), 0.0, 1.0) * outColor.a;
    `,
  },
};

const STRIDE = 15;
function createGeometry(): Geometry {
  const attributes = new Buffer({ data: new Float32Array(1),
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST, shrinkToFit: false });
  const indices = new Buffer({ data: new Uint32Array(1),
    usage: BufferUsage.INDEX | BufferUsage.COPY_DST, shrinkToFit: false });
  const stride = STRIDE * 4;
  return new Geometry({ attributes: {
    aPosition: { buffer: attributes, format: "float32x2", stride, offset: 0 },
    aUV: { buffer: attributes, format: "float32x2", stride, offset: 8 },
    aColor: { buffer: attributes, format: "unorm8x4", stride, offset: 16 },
    aTextureIdAndRound: { buffer: attributes, format: "uint16x2", stride, offset: 20 },
    aMatrix0: { buffer: attributes, format: "float32x3", stride, offset: 24 },
    aMatrix1: { buffer: attributes, format: "float32x3", stride, offset: 36 },
    aMatrix2: { buffer: attributes, format: "float32x3", stride, offset: 48 },
  }, indexBuffer: indices });
}

function createShader(maxTextures: number): Shader {
  return new Shader({
    glProgram: compileHighShaderGlProgram({ name: "inline-color-matrix-batch",
      bits: [colorBitGl, generateTextureBatchBitGl(maxTextures), roundPixelsBitGl, matrixBit] }),
    resources: { batchSamplers: getBatchSamplersUniformGroup(maxTextures) },
  });
}

/** A single Pixi batch can carry different matrices without offscreen passes. */
export class MatrixBatcher extends DefaultBatcher {
  declare geometry: Geometry;
  override shader: Shader;
  override vertexSize = STRIDE;
  private scratch = new Float32Array(0);
  private scratchWords = new Uint32Array(0);
  private shaderTextures: number;

  constructor(options: ConstructorParameters<typeof DefaultBatcher>[0]) {
    super(options);
    this.geometry.destroy();
    this.geometry = createGeometry();
    (this as unknown as { name: string }).name = "inlineColorMatrix";
    this.shader = createShader(options.maxTextures);
    this.shaderTextures = options.maxTextures;
  }

  private pack(element: MatrixElement, floats: Float32Array, words: Uint32Array,
    start: number, textureId: number, quad: boolean): void {
    const count = quad ? 4 : element.attributeSize;
    if (this.scratch.length < count * 6) {
      this.scratch = new Float32Array(count * 6);
      this.scratchWords = new Uint32Array(this.scratch.buffer);
    }
    if (quad) super.packQuadAttributes(element as DefaultBatchableQuadElement,
      this.scratch, this.scratchWords, 0, textureId);
    else super.packAttributes(element as DefaultBatchableMeshElement,
      this.scratch, this.scratchWords, 0, textureId);
    const matrix = matrices.get(element.renderable) ?? IDENTITY;
    for (let vertex = 0; vertex < count; vertex++) {
      const from = vertex * 6, to = start + vertex * STRIDE;
      floats[to] = this.scratch[from]; floats[to + 1] = this.scratch[from + 1];
      floats[to + 2] = this.scratch[from + 2]; floats[to + 3] = this.scratch[from + 3];
      words[to + 4] = this.scratchWords[from + 4];
      words[to + 5] = this.scratchWords[from + 5];
      for (let i = 0; i < 9; i++) floats[to + 6 + i] = matrix[i];
    }
  }

  override packAttributes(element: DefaultBatchableMeshElement, floats: Float32Array,
    words: Uint32Array, index: number, textureId: number): void {
    this.pack(element as MatrixElement, floats, words, index, textureId, false);
  }

  override packQuadAttributes(element: DefaultBatchableQuadElement, floats: Float32Array,
    words: Uint32Array, index: number, textureId: number): void {
    this.pack(element as MatrixElement, floats, words, index, textureId, true);
  }

  override _updateMaxTextures(maxTextures: number): void {
    if (maxTextures === this.shaderTextures) return;
    this.shader.destroy();
    this.shader = createShader(maxTextures);
    this.shaderTextures = maxTextures;
  }

  override destroy(): void {
    const shader = this.shader;
    if (!shader) return;
    super.destroy();
    shader.destroy();
  }
}

(MatrixBatcher as unknown as { extension: { type: ExtensionType[]; name: string } }).extension =
  { type: [ExtensionType.Batcher], name: "inlineColorMatrix" };

class MatrixSpritePipe {
  static extension = { type: ExtensionType.WebGLPipes, name: "matrixSprite" } as const;
  private readonly gpu = new WeakMap<MatrixSprite, BatchableSprite>();
  constructor(private readonly renderer: Renderer) {}
  private get(sprite: MatrixSprite): BatchableSprite {
    let gpu = this.gpu.get(sprite);
    if (!gpu) {
      gpu = new BatchableSprite();
      gpu.renderable = sprite;
      gpu.transform = sprite.groupTransform;
      gpu.roundPixels = (this.renderer._roundPixels | sprite._roundPixels) as 0 | 1;
      this.gpu.set(sprite, gpu);
      sprite.once("destroyed", () => gpu?.destroy());
    }
    gpu.batcherName = matrices.has(sprite) ? "inlineColorMatrix" : "default";
    if (sprite.didViewUpdate || !gpu.texture) {
      gpu.bounds = sprite.visualBounds;
      gpu.texture = sprite.texture;
    }
    return gpu;
  }
  addRenderable(sprite: MatrixSprite, instructions: InstructionSet): void {
    this.renderer.renderPipes.batch.addToBatch(this.get(sprite), instructions);
  }
  updateRenderable(sprite: MatrixSprite): void {
    const gpu = this.get(sprite);
    gpu._batcher?.updateElement(gpu);
  }
  validateRenderable(sprite: MatrixSprite): boolean {
    const gpu = this.get(sprite);
    return gpu._batcher?.name !== gpu.batcherName ||
      !gpu._batcher.checkAndUpdateTexture(gpu, sprite.texture);
  }
  destroy(): void {}
}

class MatrixNineSlicePipe {
  static extension = { type: ExtensionType.WebGLPipes, name: "matrixNineSliceSprite" } as const;
  private readonly gpu = new WeakMap<MatrixNineSliceSprite, NineSliceSpriteGpuData>();
  constructor(private readonly renderer: Renderer) {}
  private get(sprite: MatrixNineSliceSprite): NineSliceSpriteGpuData {
    let gpu = this.gpu.get(sprite);
    if (!gpu) {
      gpu = new NineSliceSpriteGpuData();
      gpu.renderable = sprite;
      gpu.transform = sprite.groupTransform;
      gpu.roundPixels = (this.renderer._roundPixels | sprite._roundPixels) as 0 | 1;
      this.gpu.set(sprite, gpu);
      sprite.once("destroyed", () => gpu?.destroy());
    }
    gpu.batcherName = matrices.has(sprite) ? "inlineColorMatrix" : "default";
    if (sprite.didViewUpdate || !gpu.texture) {
      (gpu.geometry as NineSliceGeometry).update(sprite);
      gpu.setTexture(sprite.texture);
    }
    return gpu;
  }
  addRenderable(sprite: MatrixNineSliceSprite, instructions: InstructionSet): void {
    this.renderer.renderPipes.batch.addToBatch(this.get(sprite), instructions);
  }
  updateRenderable(sprite: MatrixNineSliceSprite): void {
    const gpu = this.get(sprite);
    gpu._batcher?.updateElement(gpu);
  }
  validateRenderable(sprite: MatrixNineSliceSprite): boolean {
    const gpu = this.get(sprite);
    return gpu._batcher?.name !== gpu.batcherName ||
      !gpu._batcher.checkAndUpdateTexture(gpu, sprite.texture);
  }
  destroy(): void {}
}

export const matrixBatchExtensions = [MatrixBatcher, MatrixSpritePipe, MatrixNineSlicePipe];
