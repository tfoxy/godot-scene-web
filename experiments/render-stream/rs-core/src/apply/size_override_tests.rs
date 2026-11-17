//! render-stream-15.md "Size override": a texture drawn at a logical size other than its payload's
//! normalizes texture coordinates by the logical size, as GLES3 does (texture_set_size_override
//! sets the texture's width/height; the allocation keeps its own).

use super::*;
use crate::state::*;

/// A BC-padded atlas: stored 3368 x 2048 (a multiple of 4), drawn as 3366 x 2047.
fn atlas(size_override: Option<[u32; 2]>) -> Texture {
    Texture {
        id: 5,
        origin: Origin::Created,
        adopted_content: None,
        kind: TextureKind::Image,
        status: EntryStatus::Ok,
        reason: None,
        version: 1,
        hash: Some(Hash([7; 32])),
        format: Some("RGBA8".into()),
        source_format: None,
        width: 3368,
        height: 2048,
        mipmaps: false,
        payload_bytes: 100,
        variants: Vec::new(),
        size_override,
        canvas: None,
    }
}

fn pixels() -> payloads::TexturePixels {
    payloads::TexturePixels {
        width: 3368,
        height: 2048,
        rgba: vec![255; 16].into(),
        format: "RGBA8".into(),
        mipmaps: false,
        data_len: 3368 * 2048 * 4,
        compressed: None,
        half: None,
        floats: None,
    }
}

/// The UVs a region draw of `src` on texture 5 lowers to.
fn region_uvs(size_override: Option<[u32; 2]>, src: [f32; 4]) -> (lower::TexDraw, Vec<[f32; 2]>) {
    let mut state = ResolvedState::empty(15);
    let t = atlas(size_override);
    let hash = t.hash.unwrap();
    state.textures.insert(5, t);
    let mut store = PayloadStore::default();
    store.textures.insert(hash, pixels());
    let meshes = meshes::MeshResidency::default();
    let delivery = crate::delivery::DeliveryPrefs::default();
    let kept = HashMap::default();
    let tables = TableView {
        state: &state,
        payloads: &store,
        meshes: &meshes,
        delivery: &delivery,
        kept: &kept,
    };
    let commands = Commands {
        list: vec![Command::TextureRectRegion {
            tex: Some(5),
            transpose: false,
            clip_uv: false,
            rect: [0.0, 0.0, 100.0, 50.0],
            src,
            modulate: [1.0; 4],
        }],
        ..Commands::default()
    };
    let draw = lower::Tables::texture_draw(&tables, 5);
    let lowered = lower::lower(&commands, &tables);
    (draw, lowered.verts.iter().map(|v| v.uv).collect())
}

#[test]
fn a_region_on_a_padded_payload_normalizes_by_the_override() {
    // The far edge of the logical atlas: x in [3266, 3366], y in [1997, 2047].
    let src = [3266.0, 1997.0, 100.0, 50.0];
    let (draw, uvs) = region_uvs(Some([3366, 2047]), src);
    assert_eq!(draw, lower::TexDraw::Sized(3366, 2047, false));
    // Godot: texpixel_size = 1 / 3366 (and 1 / 2047), so the source's far edge samples u = 1.
    let (u0, u1) = (3266.0f32 * (1.0 / 3366.0), 3366.0f32 * (1.0 / 3366.0));
    let (v0, v1) = (1997.0f32 * (1.0 / 2047.0), 2047.0f32 * (1.0 / 2047.0));
    let us: Vec<f32> = uvs.iter().map(|uv| uv[0]).collect();
    let vs: Vec<f32> = uvs.iter().map(|uv| uv[1]).collect();
    assert!(!uvs.is_empty());
    for (u, v) in us.iter().zip(&vs) {
        assert!(
            (u - u0).abs() < 1e-6 || (u - u1).abs() < 1e-6,
            "u {u} is neither {u0} nor {u1}"
        );
        assert!(
            (v - v0).abs() < 1e-6 || (v - v1).abs() < 1e-6,
            "v {v} is neither {v0} nor {v1}"
        );
    }
    assert!(us.iter().any(|u| (u - 1.0).abs() < 1e-6));

    // Without the override the payload's size normalizes (two texels short of the edge).
    let (draw, uvs) = region_uvs(None, src);
    assert_eq!(draw, lower::TexDraw::Sized(3368, 2048, false));
    let far = uvs.iter().map(|uv| uv[0]).fold(0.0f32, f32::max);
    assert!((far - 3366.0 / 3368.0).abs() < 1e-6, "far u {far}");
}
