//! Runtime MTSDF tiles from caller-supplied font bytes and glyph IDs.
//! Text shaping is intentionally outside this crate.

use fdsm::{
    bezier::scanline::FillRule, generate::generate_mtsdf, render::correct_sign_mtsdf, shape::Shape,
    transform::Transform,
};
use fdsm_ttf_parser::load_shape_from_face;
use image::RgbaImage;
use nalgebra::{Affine2, Similarity2, Vector2};
use ttf_parser::{Face, GlyphId};

pub const EM_SIZE: f64 = 48.0;
pub const MAX_TILE_SIDE: u32 = 256;
pub const MAX_BATCH_TILE_BYTES: u32 = 1024 * 1024;

#[derive(Debug, PartialEq)]
pub struct GlyphTile {
    pub glyph_id: u16,
    pub width: u32,
    pub height: u32,
    pub left: f32,
    pub top: f32,
    pub advance: f32,
    pub pixels: Vec<u8>,
}

pub fn generate_tiles(
    font_bytes: &[u8],
    glyph_ids: &[u32],
    full_range: u32,
) -> Result<Vec<GlyphTile>, String> {
    if !matches!(full_range, 8 | 16 | 32) {
        return Err("unsupported MTSDF distance range".into());
    }
    if glyph_ids.len() > 256 {
        return Err("too many glyph IDs".into());
    }
    let face = Face::parse(font_bytes, 0).map_err(|_| "invalid font bytes")?;
    let scale = EM_SIZE / f64::from(face.units_per_em());
    let margin = f64::from(full_range) / 2.0 + 2.0;
    let mut plans = Vec::with_capacity(glyph_ids.len());
    let mut total_bytes = 0u32;
    // Size the entire batch before allocating the first raster image.
    for &id in glyph_ids {
        let id = u16::try_from(id).map_err(|_| "glyph ID out of range")?;
        if id == 0 || id >= face.number_of_glyphs() {
            return Err(format!("glyph ID {id} is missing"));
        }
        let glyph_id = GlyphId(id);
        let advance = face.glyph_hor_advance(glyph_id).unwrap_or(0) as f64 * scale;
        let Some(bbox) = face.glyph_bounding_box(glyph_id) else {
            plans.push((glyph_id, advance, None));
            continue;
        };
        let outline_width = i32::from(bbox.x_max) - i32::from(bbox.x_min);
        let outline_height = i32::from(bbox.y_max) - i32::from(bbox.y_min);
        let width = ((f64::from(outline_width) * scale) + 2.0 * margin).ceil() as u32;
        let height = ((f64::from(outline_height) * scale) + 2.0 * margin).ceil() as u32;
        if width == 0 || height == 0 || width > MAX_TILE_SIDE || height > MAX_TILE_SIDE {
            return Err(format!("glyph ID {id} exceeds tile bounds"));
        }
        let bytes = width
            .checked_mul(height)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or("tile byte size overflow")?;
        total_bytes = total_bytes
            .checked_add(bytes)
            .ok_or("batch tile byte size overflow")?;
        if total_bytes > MAX_BATCH_TILE_BYTES {
            return Err("MTSDF batch exceeds 1 MiB of tile pixels".into());
        }
        plans.push((glyph_id, advance, Some((bbox, width, height))));
    }
    let mut tiles = Vec::with_capacity(plans.len());
    for (glyph_id, advance, layout) in plans {
        let id = glyph_id.0;
        let Some((bbox, width, height)) = layout else {
            tiles.push(GlyphTile {
                glyph_id: id,
                width: 0,
                height: 0,
                left: 0.0,
                top: 0.0,
                advance: advance as f32,
                pixels: Vec::new(),
            });
            continue;
        };
        let mut shape = load_shape_from_face(&face, glyph_id)
            .ok_or_else(|| format!("glyph ID {id} has no outline"))?;
        let transform: Affine2<f64> = nalgebra::convert(Similarity2::new(
            Vector2::new(
                margin - f64::from(bbox.x_min) * scale,
                margin - f64::from(bbox.y_min) * scale,
            ),
            0.0,
            scale,
        ));
        shape.transform(&transform);
        let colored = Shape::edge_coloring_simple(shape, 0.03, u64::from(id));
        let prepared = colored.prepare();
        let mut image = RgbaImage::new(width, height);
        generate_mtsdf(&prepared, f64::from(full_range), &mut image);
        correct_sign_mtsdf(&mut image, &prepared, FillRule::Nonzero);
        // Font coordinates point up; canvas texture coordinates point down.
        let mut pixels = vec![0; (width * height * 4) as usize];
        for y in 0..height {
            for x in 0..width {
                let target = ((y * width + x) * 4) as usize;
                pixels[target..target + 4].copy_from_slice(&image.get_pixel(x, height - 1 - y).0);
            }
        }
        tiles.push(GlyphTile {
            glyph_id: id,
            width,
            height,
            left: (f64::from(bbox.x_min) * scale - margin) as f32,
            top: (-f64::from(bbox.y_max) * scale - margin) as f32,
            advance: advance as f32,
            pixels,
        });
    }
    Ok(tiles)
}

#[cfg(target_arch = "wasm32")]
mod web {
    use super::generate_tiles;
    use js_sys::{Array, Object, Reflect, Uint8Array};
    use wasm_bindgen::JsCast;
    use wasm_bindgen::prelude::*;

    fn field(object: &Object, name: &str, value: JsValue) -> Result<(), JsValue> {
        Reflect::set(object, &JsValue::from_str(name), &value).map(|_| ())
    }

    /// The returned Uint8Arrays are copied out of WASM and transferred by the worker.
    #[wasm_bindgen]
    pub fn generate_mtsdf_tiles(
        font_bytes: &[u8],
        glyph_ids: &[u32],
        full_range: u32,
    ) -> Result<Array, JsValue> {
        let tiles =
            generate_tiles(font_bytes, glyph_ids, full_range).map_err(|e| JsValue::from_str(&e))?;
        let result = Array::new();
        for tile in tiles {
            let object = Object::new();
            field(
                &object,
                "glyphId",
                JsValue::from_f64(f64::from(tile.glyph_id)),
            )?;
            field(&object, "width", JsValue::from_f64(f64::from(tile.width)))?;
            field(&object, "height", JsValue::from_f64(f64::from(tile.height)))?;
            field(&object, "left", JsValue::from_f64(f64::from(tile.left)))?;
            field(&object, "top", JsValue::from_f64(f64::from(tile.top)))?;
            field(
                &object,
                "advance",
                JsValue::from_f64(f64::from(tile.advance)),
            )?;
            field(
                &object,
                "pixels",
                Uint8Array::from(tile.pixels.as_slice()).into(),
            )?;
            result.push(&object);
        }
        Ok(result)
    }

    #[wasm_bindgen]
    pub fn wasm_memory_bytes() -> u32 {
        let memory: js_sys::WebAssembly::Memory = wasm_bindgen::memory().unchecked_into();
        let buffer: js_sys::ArrayBuffer = memory.buffer().unchecked_into();
        buffer.byte_length()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FONT: &[u8] = include_bytes!("../test/fixtures/LiberationSansNarrow-Regular.ttf");

    #[test]
    fn deterministic_complex_glyphs_and_inkless_space() {
        let face = Face::parse(FONT, 0).unwrap();
        let ids: Vec<u32> = ['B', 'O', '@', ' ']
            .iter()
            .map(|c| face.glyph_index(*c).unwrap().0 as u32)
            .collect();
        let a = generate_tiles(FONT, &ids, 16).unwrap();
        let b = generate_tiles(FONT, &ids, 16).unwrap();
        assert_eq!(a, b);
        assert!(
            a[..3].iter().all(|tile| tile.width > 0
                && tile.pixels.len() == (tile.width * tile.height * 4) as usize)
        );
        assert_eq!(a[3].width, 0);
        assert!(a[3].advance > 0.0);
        assert!(
            a[..3]
                .iter()
                .all(|tile| tile.pixels.iter().any(|&pixel| pixel != 0))
        );
    }

    #[test]
    fn rejects_bad_inputs_and_supports_all_ranges() {
        let face = Face::parse(FONT, 0).unwrap();
        let id = face.glyph_index('B').unwrap().0 as u32;
        for range in [8, 16, 32] {
            let tile = generate_tiles(FONT, &[id], range).unwrap().remove(0);
            assert!(tile.width > 0 && tile.height > 0);
            assert_eq!(tile.pixels.len(), (tile.width * tile.height * 4) as usize);
        }
        assert!(generate_tiles(FONT, &[id], 4).is_err());
        assert!(generate_tiles(b"bad", &[id], 8).is_err());
        assert!(generate_tiles(FONT, &[0], 8).is_err());
    }

    #[test]
    fn rejects_oversized_aggregate_before_rasterizing() {
        let face = Face::parse(FONT, 0).unwrap();
        let id = u32::from(face.glyph_index('@').unwrap().0);
        // Each valid tile fits; the combined 1 MiB budget does not.
        let error = generate_tiles(FONT, &vec![id; 80], 16).unwrap_err();
        assert!(error.contains("batch exceeds 1 MiB"), "{error}");
    }

    #[test]
    fn overlapping_contours_have_a_continuous_union_interior() {
        use fdsm::{
            bezier::{Point, Segment},
            shape::Contour,
        };
        fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Contour {
            let p = [
                Point::new(x0, y0),
                Point::new(x1, y0),
                Point::new(x1, y1),
                Point::new(x0, y1),
            ];
            Contour {
                segments: (0..4)
                    .map(|i| Segment::line(p[i], p[(i + 1) % 4]))
                    .collect(),
            }
        }
        let shape = Shape {
            contours: vec![rect(12.0, 12.0, 36.0, 44.0), rect(28.0, 20.0, 52.0, 52.0)],
        };
        let colored = Shape::edge_coloring_simple(shape, 0.03, 1234);
        let prepared = colored.prepare();
        let mut image = RgbaImage::new(64, 64);
        generate_mtsdf(&prepared, 16.0, &mut image);
        correct_sign_mtsdf(&mut image, &prepared, FillRule::Nonzero);
        let inside = |x, y| {
            let [r, g, b, _] = image.get_pixel(x, y).0;
            let mut channels = [r, g, b];
            channels.sort();
            channels[1] >= 128
        };
        for y in 0..64 {
            for x in 0..64 {
                let first_inner = (14..=34).contains(&x) && (14..=42).contains(&y);
                let second_inner = (30..=50).contains(&x) && (22..=50).contains(&y);
                if first_inner || second_inner {
                    assert!(inside(x, y), "overlap union gap at ({x},{y})");
                }
                let first_near = (10..=38).contains(&x) && (10..=46).contains(&y);
                let second_near = (26..=54).contains(&x) && (18..=54).contains(&y);
                if !first_near && !second_near {
                    assert!(!inside(x, y), "overlap exterior filled at ({x},{y})");
                }
            }
        }
        if let Ok(path) = std::env::var("GSW_MSDF_OVERLAP_PPM") {
            let mut ppm = b"P6\n64 64\n255\n".to_vec();
            for y in 0..64 {
                for x in 0..64 {
                    let value = if inside(x, y) { 255 } else { 0 };
                    ppm.extend([value; 3]);
                }
            }
            std::fs::write(path, ppm).unwrap();
        }
    }
}
