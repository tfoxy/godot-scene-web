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
