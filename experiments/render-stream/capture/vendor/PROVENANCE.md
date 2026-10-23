# Vendored third-party files

Per this repository's rule, a vendored third-party file is digest-pinned with its
license and provenance beside it.

## `gdextension_interface.h`

- Upstream: Godot Engine, `core/extension/gdextension_interface.h`
- Source checkout: `../godot-4.5.1-stable` (tag `4.5.1-stable`, commit
  `f62fdbde15035c5576dad93e586201f4d41ef0cb`)
- sha256: `a40ac4fca0f526910bd0e6afc6da6c169f50801c84d4e29c4ce2891cadc7b550`
- Copied verbatim; not modified. It is the only Godot source this library
  compiles against — the capture library deliberately does not use `godot-cpp`.

## `LICENSE.txt`

- Upstream: Godot Engine, `LICENSE.txt` (MIT) from the same commit
- sha256: `b0435e3b3e4e55238f05f4b306f30524a1b2e20147810d436eaa554fa6855c80`

Everything the capture library knows about Godot's internal C++ ABI
(`RID`, `Rect2`, `Color`, `Vector<T>`'s CowData header, `Ref<T>`) is reproduced
in `src/abi.h` from the same checkout rather than copied, so no GPL/MIT engine
internals are vendored beyond the public extension header above.

## `zstd/` (G8kz)

- Upstream: https://github.com/facebook/zstd, version 1.5.7 (`f8745da6ff1ad1e7bab384bd1f9d742439278e99`),
  BSD-3-Clause (`zstd/LICENSE`)
- Source: `../godot-4.5.1-stable/thirdparty/zstd` (tag `4.5.1-stable`), copied verbatim, nothing
  downloaded: `common/`, `compress/`, `decompress/` (minus `huf_decompress_amd64.S`; the build
  defines `ZSTD_DISABLE_ASM`), `zstd.h`, `zstd_errors.h`, `LICENSE`
- `zstd.h` sha256: `9b4bc8245565c98ccfc61c07749928b57e7c0f6fddb0530c4f6aa1971893d88b`
- Tree digest (sha256 over each file's relative path and content sha256, sorted): 64 files,
  `01a11d3526c20000b1a8c5d43373da453189777cd55a8ef0a2c91390ab000dc9`
- Use: the host's HTTP `Content-Encoding: zstd` (`src/rs_http_coding.cpp`). Built as a
  hidden-visibility static library, `grc_codecs`.

## `zlib/` (G8kz)

- Upstream: https://www.zlib.net, version 1.3.1, zlib license (`zlib/LICENSE`)
- Source: `../godot-4.5.1-stable/thirdparty/zlib`, copied verbatim, nothing downloaded: every
  `.c` and `.h` except `compress.c` and `uncompr.c`, plus `LICENSE`
- `zlib.h` sha256: `8a5579af72ea4f427ff00a4150f0ccb3fc5c1e4379f726e101133b1ab9fc600c`
- Tree digest (as above): 20 files, `fda8b37fed9e1c5e7e9bbaa3d3cc6c75377d61098ff36a410087ae25229ef198`
- Use: the host's HTTP `Content-Encoding: gzip`, and the tests' decoder (`grc_codecs`).
