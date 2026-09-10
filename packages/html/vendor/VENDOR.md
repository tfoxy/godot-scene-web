# Godot default-theme font

`OpenSans_SemiBold.woff2` is a committed third-party binary, not a build
output. Godot 4.5.1 embeds these exact bytes as its default GUI theme font
(`scene/theme/default_theme.cpp` calls `set_data_ptr(_font_OpenSans_SemiBold,
...)`). The HTML renderer embeds the same bytes as a data URL so it works both
for source consumers and for a packed package without a host-specific asset
copy rule.

| file | bytes | sha256 |
| --- | ---: | --- |
| `OpenSans_SemiBold.woff2` | 46 392 | `661e2d9975d3029aeb32bf37b1b963c31c7c3ce08ac1bab2c8ebe27e135c4ec2` |

## Provenance

- Source: Godot Engine 4.5.1-stable,
  `thirdparty/fonts/OpenSans_SemiBold.woff2`, copied byte-for-byte.
- Godot records its upstream as [Google Fonts: Open Sans](https://fonts.google.com/specimen/Open+Sans),
  version 1.10, downloaded February 2021, under Apache License 2.0
  (`thirdparty/README.md`).
- The file was converted by Godot from the unhinted TTF source using
  [google/woff2](https://github.com/google/woff2), as recorded in that same
  Godot third-party manifest.

## Packaging

`scripts/inline-default-font.mjs` regenerates
`src/default-font-data.ts` from this binary. That module is imported by the
renderer, so tsdown carries the data URL into `dist` and Vite source consumers
need neither a special URL resolver nor a copied font asset. The vendor binary
and this provenance file remain in the npm package for auditability.

## Default bold role

Godot does not select a separate Open Sans Bold file for `[b]`: its default
theme constructs a `FontVariation` over this SemiBold face with
`variation_embolden = 1.2` (`scene/theme/default_theme.cpp`). In
`TextServerAdvanced`, the variation contributes
`embolden * (font_size * 64) / 4096` to every glyph advance: 0.3 px at the
default 16 px. Browser `font-synthesis` changes glyph ink but does not make
`Range` geometry include that advance. The renderer therefore uses a 0.5 px
tracking emulation for the *implicit* default bold role: 0.3 px from Godot's
formula plus the measured cross-shaper/hinting rounding gap. It is deliberately
not applied when an explicit bold FontFile/FontVariation resolves, and it
resets a normal FontVariation's `spacing_glyph` instead of inheriting it.

## License

Godot declares this historical Open Sans 1.10 binary Apache License 2.0. The
verbatim license text is in `LICENSE-OpenSans`; retain it with every copy of
the binary.
