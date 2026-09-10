/**
 * The executor's texture cache — PER CONTEXT, and its own rather than a
 * generalization of `@godot-scene-web/html`'s.
 *
 * WHY NOT REUSE `html/webgl/shared-gl`'s CACHE. That module opens with a note
 * saying its single context and its single module-scoped texture map are
 * load-bearing: both live runtimes (shaders and particles) must share ONE
 * WebGL2 context, because a page with many cards would otherwise walk into the
 * browser's ~16-live-context limit, and ONE cache, so identical urls upload once.
 * Threading a context parameter through it would turn a documented singleton into
 * a keyed registry — a real change to an invariant two shipping runtimes rest on,
 * to serve a consumer that wants DIFFERENT pixels anyway:
 *
 * - a `WebGLTexture` belongs to the context that made it and cannot be bound in
 *   another, so the stage's own context could not use those entries even if it
 *   could see them;
 * - shared-gl uploads STRAIGHT alpha (`UNPACK_PREMULTIPLY_ALPHA_WEBGL` false),
 *   because its shaders do Godot's multiply themselves; this cache uploads
 *   PREMULTIPLIED (see below), which is a different byte in every texel;
 * - shared-gl's entries are immortal and url-keyed with a load listener; a stage
 *   that paints hundreds of megabytes of card atlas needs refcounts and a
 *   `reset()` for context loss.
 *
 * So this is option (b) from the brief: a small cache of its own, ~150 lines, no
 * change to a package two runtimes depend on.
 *
 * PREMULTIPLIED UPLOAD IS THE POINT, not a detail. `LINEAR` filtering blends
 * texels; blending STRAIGHT colour weights a fully transparent texel's (usually
 * black, or garbage) RGB equally with its opaque neighbour's, so every sprite
 * edge gets a dark fringe and every atlas region bleeds its padding. Blending
 * PREMULTIPLIED colour weights each texel's contribution by its own alpha, which
 * is the arithmetic filtering is supposed to be doing. It also means a texel and
 * the quad's tint compose with one componentwise multiply, and it is the same
 * convention the stage canvas is declared with — one statement of the rule from
 * the PNG to the compositor.
 *
 * SOURCES MUST BE READY. This module never decodes: it uploads what it is handed.
 * A half-loaded `HTMLImageElement` uploads as nothing useful, so the caller
 * decodes (`decode()`, `createImageBitmap`, a canvas it drew itself) and hands
 * over a finished source. That keeps the whole package clear of DOM lifecycle —
 * reading `.width` off an object someone else created is the only thing here that
 * touches a DOM-shaped value.
 */

/** Anything WebGL can upload directly. */
export type CanvasTextureSource = TexImageSource;

/** A cached texture. `width`/`height` are the UPLOADED pixel dimensions, which is
 *  what normalizes a draw-list's page-pixel source rect into UVs. */
export interface CanvasTextureHandle {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
}

export interface TextureCacheStats {
  /** Live entries. */
  entries: number;
  /** Pixel uploads made: `texImage2D` calls plus the `texSubImage2D` re-uploads
   *  {@link CanvasTextureCache.update} does into storage that already fits. */
  uploads: number;
  /** Of those, the ones that had to RE-SPECIFY the texture's storage — a first
   *  upload, or an `update` whose source changed size. The difference between
   *  this and `uploads` is how often the re-upload fast path was taken, which is
   *  the number a consumer that streams into one key wants to watch. */
  respecs: number;
  /** Entries deleted because their last reference was released. */
  evictions: number;
  /** Resident RGBA bytes, including every generated mip level. */
  bytes: number;
}

/** Sampling and source-alpha options shared by texture acquisition methods.
 *
 * Mipmaps make minification stable, but their filtered levels can sample pixels
 * outside an atlas rect. Use them only for standalone images or padded atlases.
 */
export interface CanvasTextureOptions {
  /** `true` when the source already contains `rgb * a`. Defaults to false. */
  premultiplied?: boolean;
  /** Generate a complete mip chain. Not suitable for unpadded atlas pages. */
  mipmap?: boolean;
  /** Minification filter. Defaults to LINEAR, or LINEAR_MIPMAP_LINEAR with mips. */
  minFilter?: number;
  /** Magnification filter. Defaults to LINEAR; NEAREST is supported. */
  magFilter?: number;
}

export interface CanvasTextureCache {
  readonly stats: TextureCacheStats;
  /** The 1x1 opaque-white texel every untextured quad samples, so a solid fill
   *  needs no second shader and no special slot. */
  white(): CanvasTextureHandle;
  /** Look up without uploading or retaining. */
  peek(key: string): CanvasTextureHandle | undefined;
  /**
   * Upload `source` under `key` and take a reference. A key already present is
   * NOT re-uploaded (that is the decode-once guarantee) — only referenced again;
   * use {@link CanvasTextureCache.update} to replace its pixels.
   */
  acquire(
    key: string,
    source: CanvasTextureSource,
    options?: CanvasTextureOptions,
  ): CanvasTextureHandle;
  /**
   * Same, from raw RGBA bytes. `premultiplied` says whether `pixels` already
   * carries `rgb*a`; when it does not, the multiply happens HERE in JS rather
   * than through `UNPACK_PREMULTIPLY_ALPHA_WEBGL`, whose behaviour over an
   * `ArrayBufferView` is not worth depending on.
   */
  acquireBytes(
    key: string,
    pixels: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    options?: CanvasTextureOptions,
  ): CanvasTextureHandle;
  /** Take another reference to an existing key. Throws when it is not present. */
  retain(key: string): CanvasTextureHandle;
  /** Drop a reference; the entry is deleted when the last one goes. */
  release(key: string): void;
  /**
   * Replace an existing (or create a new) entry's pixels, keeping its refcount.
   *
   * A source the same size as what the entry already holds is re-uploaded with
   * `texSubImage2D`, INTO the storage that is already there; only a size change
   * re-specifies it with `texImage2D`. That matters for a consumer streaming a
   * live surface into one key every frame, which is the shape this method exists
   * for: a re-spec frees the old mip level and allocates a new one on every call,
   * so a same-size stream would churn a few megabytes of driver allocation per
   * frame to write the same number of texels. See `stats.respecs`.
   */
  update(key: string, source: CanvasTextureSource): CanvasTextureHandle;
  /**
   * Write `source` into an EXISTING entry's storage at `(x, y)`, leaving the rest
   * of it untouched. Nothing is allocated, nothing is re-specified, the refcount
   * does not move, and the sampler parameters are not re-set.
   *
   * This is the ATLAS PAGE case, and it is why {@link CanvasTextureCache.update}
   * is not enough for it. A page is one texture that many small sources are
   * written into over time; `update` can only replace the whole thing, so a
   * consumer holding a 1024x1024 page would have to re-upload all four megabytes
   * every time one 40x18 label changed — which on a phone is tens of milliseconds
   * for a few kilobytes of new pixels. Writing just the region is proportional to
   * what actually changed.
   *
   * REFUSED, with `null` and no GL call at all, when the key is unknown or when
   * the rect does not lie wholly inside the entry's real storage (see
   * `Entry.storageW`, which is not always the entry's claimed size). Both would
   * otherwise be a silent `INVALID_VALUE` on the context — an error the caller
   * cannot see and the next draw cannot explain. A refusal is a fact the caller
   * is expected to handle (re-allocate, or fall back), not an exception.
   *
   * Counted as one `uploads` and never a `respec`, which is the distinction the
   * stat exists to make.
   */
  updateRegion(
    key: string,
    source: CanvasTextureSource,
    x: number,
    y: number,
  ): CanvasTextureHandle | null;
  /** The context was lost: forget every entry WITHOUT touching the dead driver. */
  reset(): void;
  /** Delete every texture and empty the cache. */
  dispose(): void;
}

interface Entry {
  texture: WebGLTexture;
  width: number;
  height: number;
  refs: number;
  /** What the texture's STORAGE was really specified at by the last
   *  `texImage2D`, which is not always `width`/`height`: those are clamped up to
   *  1 (see {@link sourceSize}), so a source that reported 0x0 leaves an entry
   *  claiming 1x1 over a mip level that is 0x0 or absent. `update`'s fast path
   *  writes into existing storage, so it has to test the storage rather than the
   *  claim — otherwise that entry's next same-size update would be a
   *  `texSubImage2D` past the end of a level that is not there. */
  storageW: number;
  storageH: number;
  mipmap: boolean;
  minFilter: number;
  magFilter: number;
  premultiplied: boolean;
}

function textureBytes(width: number, height: number, mipmap: boolean): number {
  if (width <= 0 || height <= 0) return 0;
  let bytes = 0;
  while (true) {
    bytes += width * height * 4;
    if (!mipmap || (width === 1 && height === 1)) return bytes;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }
}

/** Exact `round(channel * alpha / 255)` for all byte pairs. */
function premultiplyByte(channel: number, alpha: number): number {
  const t = channel * alpha + 0x80;
  return (t + (t >> 8)) >> 8;
}

/** Pixel dimensions of an upload source, as the source itself reports them —
 *  0 included. */
function rawSourceSize(source: CanvasTextureSource): {
  width: number;
  height: number;
} {
  const any = source as {
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    width?: number;
    height?: number;
  };
  return {
    width: any.naturalWidth || any.videoWidth || any.width || 0,
    height: any.naturalHeight || any.videoHeight || any.height || 0,
  };
}

/** The same, clamped to at least 1x1 — what an entry records and what UV
 *  normalization divides by, neither of which may be zero. */
function sourceSize(source: CanvasTextureSource): {
  width: number;
  height: number;
} {
  const raw = rawSourceSize(source);
  return {
    width: Math.max(1, raw.width),
    height: Math.max(1, raw.height),
  };
}

export function createTextureCache(
  gl: WebGL2RenderingContext,
): CanvasTextureCache {
  const entries = new Map<string, Entry>();
  let whiteEntry: Entry | null = null;
  let premultiplyScratch = new Uint8Array(0);
  const stats: TextureCacheStats = {
    entries: 0,
    uploads: 0,
    respecs: 0,
    evictions: 0,
    bytes: 0,
  };

  function resolvedOptions(
    options: CanvasTextureOptions = {},
  ): Required<CanvasTextureOptions> {
    const mipmap = options.mipmap ?? false;
    return {
      premultiplied: options.premultiplied ?? false,
      mipmap,
      minFilter:
        options.minFilter ?? (mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR),
      magFilter: options.magFilter ?? gl.LINEAR,
    };
  }

  // CLAMP_TO_EDGE avoids wrapping across a page edge. Mipmaps themselves still
  // interpolate adjacent atlas regions, hence the public padded-atlas warning.
  function configure(entry: Entry): void {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, entry.minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, entry.magFilter);
  }

  // The unpack state both source uploads run under, stated once so the fast path
  // below cannot drift from the full one. Row 0 of the source lands at V=0, i.e.
  // the top-left origin the draw-list's page-pixel source rects are expressed in
  // — a FLIP_Y upload would render every sprite upside down while every UV still
  // looked right — and PREMULTIPLY is the package's contract (see the header).
  function unpackForSource(premultiplied: boolean): void {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !premultiplied);
  }

  function regenerateMipmap(entry: Entry): void {
    if (entry.mipmap && entry.storageW > 0 && entry.storageH > 0) {
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  function uploadSource(entry: Entry, source: CanvasTextureSource): void {
    const raw = rawSourceSize(source);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    unpackForSource(entry.premultiplied);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    configure(entry);
    entry.storageW = raw.width;
    entry.storageH = raw.height;
    regenerateMipmap(entry);
    stats.uploads += 1;
    stats.respecs += 1;
  }

  /** Re-upload over storage that is ALREADY the source's size. No `texImage2D`,
   *  so no reallocation; no `configure()` either, because sampler parameters live
   *  on the texture object and nothing here touches them. */
  function reuploadSource(entry: Entry, source: CanvasTextureSource): void {
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    unpackForSource(entry.premultiplied);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    regenerateMipmap(entry);
    stats.uploads += 1;
  }

  /** Write a source into part of storage that is already there. Like
   *  {@link reuploadSource} it neither allocates nor re-configures; unlike it, the
   *  destination offset is the caller's. */
  function uploadRegion(
    entry: Entry,
    source: CanvasTextureSource,
    x: number,
    y: number,
  ): void {
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    unpackForSource(entry.premultiplied);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, source);
    regenerateMipmap(entry);
    stats.uploads += 1;
  }

  function uploadBytes(
    entry: Entry,
    pixels: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    premultiplied: boolean,
  ): void {
    let data =
      pixels instanceof Uint8Array
        ? pixels
        : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    if (!premultiplied) {
      if (premultiplyScratch.length < data.length) {
        premultiplyScratch = new Uint8Array(data.length);
      }
      const premultipliedData = premultiplyScratch.subarray(0, data.length);
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        premultipliedData[i] = premultiplyByte(data[i], a);
        premultipliedData[i + 1] = premultiplyByte(data[i + 1], a);
        premultipliedData[i + 2] = premultiplyByte(data[i + 2], a);
        premultipliedData[i + 3] = a;
      }
      data = premultipliedData;
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    configure(entry);
    entry.storageW = width;
    entry.storageH = height;
    regenerateMipmap(entry);
    stats.uploads += 1;
    stats.respecs += 1;
  }

  function track(entry: Entry, width: number, height: number): void {
    stats.bytes +=
      textureBytes(width, height, entry.mipmap) -
      textureBytes(entry.width, entry.height, entry.mipmap);
    entry.width = width;
    entry.height = height;
  }

  function makeEntry(
    width: number,
    height: number,
    options: CanvasTextureOptions = {},
  ): Entry {
    const resolved = resolvedOptions(options);
    const entry: Entry = {
      texture: gl.createTexture(),
      width: 0,
      height: 0,
      refs: 0,
      // No storage yet: the upload that follows every `makeEntry` sets these.
      // Until it does, nothing can match, so nothing can take the fast path.
      storageW: -1,
      storageH: -1,
      mipmap: resolved.mipmap,
      minFilter: resolved.minFilter,
      magFilter: resolved.magFilter,
      premultiplied: resolved.premultiplied,
    };
    track(entry, width, height);
    stats.entries += 1;
    return entry;
  }

  return {
    stats,

    white() {
      if (whiteEntry) return whiteEntry;
      const entry = makeEntry(1, 1);
      uploadBytes(entry, new Uint8Array([255, 255, 255, 255]), 1, 1, true);
      // Never released: it is a single texel and every solid fill on the page
      // samples it.
      entry.refs = 1;
      whiteEntry = entry;
      return entry;
    },

    peek(key) {
      return entries.get(key);
    },

    acquire(key, source, options) {
      const existing = entries.get(key);
      if (existing) {
        existing.refs += 1;
        return existing;
      }
      const { width, height } = sourceSize(source);
      const entry = makeEntry(width, height, options);
      uploadSource(entry, source);
      entry.refs = 1;
      entries.set(key, entry);
      return entry;
    },

    acquireBytes(key, pixels, width, height, options) {
      const existing = entries.get(key);
      if (existing) {
        existing.refs += 1;
        return existing;
      }
      const entry = makeEntry(Math.max(1, width), Math.max(1, height), options);
      uploadBytes(
        entry,
        pixels,
        entry.width,
        entry.height,
        options?.premultiplied ?? false,
      );
      entry.refs = 1;
      entries.set(key, entry);
      return entry;
    },

    retain(key) {
      const entry = entries.get(key);
      if (!entry) {
        throw new Error(`texture cache: retain of unknown key "${key}"`);
      }
      entry.refs += 1;
      return entry;
    },

    release(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      gl.deleteTexture(entry.texture);
      entries.delete(key);
      stats.entries -= 1;
      stats.evictions += 1;
      stats.bytes -= textureBytes(entry.width, entry.height, entry.mipmap);
    },

    update(key, source) {
      const raw = rawSourceSize(source);
      const entry = entries.get(key);
      // Same storage, same source size: write over the level that is already
      // there. This is the streaming case — one key, a new frame every tick —
      // and it is why the entry remembers what its storage really is rather than
      // what it claims (see `Entry.storageW`).
      if (
        entry &&
        entry.storageW === raw.width &&
        entry.storageH === raw.height
      ) {
        reuploadSource(entry, source);
        return entry;
      }
      const width = Math.max(1, raw.width);
      const height = Math.max(1, raw.height);
      if (!entry) {
        const created = makeEntry(width, height);
        created.refs = 1;
        entries.set(key, created);
        uploadSource(created, source);
        return created;
      }
      track(entry, width, height);
      uploadSource(entry, source);
      return entry;
    },

    updateRegion(key, source, x, y) {
      const entry = entries.get(key);
      if (!entry || entry.mipmap) return null;
      const raw = rawSourceSize(source);
      // The whole rect must be inside the storage that really exists. `raw` and
      // not `sourceSize` on purpose: a 0-sized source would write nothing, and
      // clamping it up to 1 here would claim it wrote a texel it did not.
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        raw.width <= 0 ||
        raw.height <= 0 ||
        x + raw.width > entry.storageW ||
        y + raw.height > entry.storageH
      ) {
        return null;
      }
      uploadRegion(entry, source, x, y);
      return entry;
    },

    reset() {
      // No `deleteTexture`: after a context loss every name is already invalid and
      // asking the dead context to free them is at best a no-op and at worst a
      // stream of GL errors on the next restore.
      entries.clear();
      whiteEntry = null;
      stats.entries = 0;
      stats.bytes = 0;
    },

    dispose() {
      for (const entry of entries.values()) gl.deleteTexture(entry.texture);
      if (whiteEntry) gl.deleteTexture(whiteEntry.texture);
      entries.clear();
      whiteEntry = null;
      stats.entries = 0;
      stats.bytes = 0;
    },
  };
}
