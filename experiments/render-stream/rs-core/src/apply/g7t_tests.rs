//! G7t's lowering and mesh-residency tests (gates 4 and 5): feathers, binary16 primitive colours,
//! nine-patch tiling, GL line/point primitives, the lowering sabotages, and the native mesh
//! census rows. Hand-built commands and tables (no decoder, no GPU).

use super::geom;
use super::lower::{self, LowerSabotage, Shortcut, TexDraw};
use super::meshes::{MeshResidency, MeshSabotage};
use super::payloads::{mesh_geometry, MeshBuffers, MeshGeometry, PayloadStore};
use crate::state::*;
use std::collections::HashMap;

struct Tables {
    textures: HashMap<Id, (u32, u32)>,
}

impl lower::Tables for Tables {
    fn texture_draw(&self, id: Id) -> TexDraw {
        match self.textures.get(&id) {
            Some((w, h)) => TexDraw::Sized(*w, *h, false),
            None => TexDraw::Skip,
        }
    }
    fn mesh(&self, _id: Id) -> Option<(Vec<&MeshGeometry>, geom::Rect)> {
        None
    }
}

fn no_tables() -> Tables {
    Tables {
        textures: HashMap::new(),
    }
}

fn commands(list: Vec<Command>, f32s: Vec<f32>) -> Commands {
    Commands {
        list,
        f32s,
        i32s: Vec::new(),
    }
}

fn shortcut(l: &lower::Lowered, s: Shortcut) -> u32 {
    l.shortcuts
        .iter()
        .find(|(k, _)| *k == s)
        .map(|(_, n)| *n)
        .unwrap_or(0)
}

#[test]
fn godot_half_truncates_like_make_half_float() {
    // 0.6 = 0x3F19999A: the mantissa's low 13 bits are dropped, not rounded.
    assert_eq!(geom::godot_half(0.6), 0.599_609_4);
    assert_eq!(geom::godot_half(1.0), 1.0);
    assert_eq!(geom::godot_half(0.0), 0.0);
    // Below the half's normal range: zero.
    assert_eq!(geom::godot_half(1.0e-5), 0.0);
}

#[test]
fn antialiased_line_adds_the_engines_eight_feather_primitives() {
    let c = [1.0, 1.0, 0.2, 1.0];
    let cmds = commands(
        vec![Command::Line {
            aa: true,
            from: [8.0, 56.0],
            to: [64.0, 72.0],
            colour: c,
            width: 4.0,
        }],
        vec![],
    );
    let l = lower::lower(&cmds, &no_tables());
    // The line's quad and 8 feather quads, each a 4-point primitive (2 triangles).
    assert_eq!(l.verts.len(), 4 * 9);
    assert_eq!(l.idx.len(), 6 * 9);
    assert_eq!(shortcut(&l, Shortcut::AaFeatherOmitted), 0);
    // Colours through binary16; the feathers' outer points are transparent.
    assert_eq!(l.verts[0].color[2], geom::godot_half(0.2));
    assert_eq!(l.verts[5].color[3], 0.0);
    // The item rect grows by the feathers (each primitive is a command of its own in get_rect).
    let base = geom::points_box(geom::line_points([8.0, 56.0], [64.0, 72.0], 4.0).0);
    assert!(l.rect[0] < base[0] && l.rect[2] > base[2]);
}

#[test]
fn antialiased_rect_circle_and_polyline_carry_feathers() {
    let c = [1.0, 0.6, 0.2, 1.0];
    let rect = lower::lower(
        &commands(
            vec![Command::Rect {
                aa: true,
                rect: [8.0, 8.0, 48.0, 32.0],
                color: c,
            }],
            vec![],
        ),
        &no_tables(),
    );
    assert_eq!(rect.verts.len(), 4 + 8 * 4);
    // The first feather (left_border) starts at the rect's corner and moves by (0, -1.25).
    assert_eq!(rect.verts[4].pos, [8.0, 8.0]);
    assert_eq!(rect.verts[5].pos, [8.0, 8.0 - geom::FEATHER_SIZE]);

    let circle = lower::lower(
        &commands(
            vec![Command::Circle {
                aa: true,
                position: [100.0, 40.0],
                radius: 4.0,
                colour: c,
            }],
            vec![],
        ),
        &no_tables(),
    );
    // 66 fan points, then the 130-point feather strip (128 triangles).
    assert_eq!(circle.verts.len(), 66 + 130);
    assert_eq!(circle.idx.len(), 64 * 3 + 128 * 3);

    // Polyline (8,8)-(64,8)-(64,40): middle strip 2n+4, left and right strips 2n+5 each.
    let pts = vec![8.0, 8.0, 64.0, 8.0, 64.0, 40.0];
    let mut f32s = pts.clone();
    f32s.extend_from_slice(&c);
    let poly = lower::lower(
        &commands(
            vec![Command::Polyline {
                aa: true,
                width: 4.0,
                points: Span { start: 0, len: 3 },
                colors: Span { start: 6, len: 1 },
            }],
            f32s,
        ),
        &no_tables(),
    );
    assert_eq!(poly.verts.len(), (6 + 4) + 2 * (6 + 5));
}

#[test]
fn hairlines_and_points_are_counted_quads() {
    let c = [0.6, 1.0, 0.6, 1.0];
    let l = lower::lower(
        &commands(
            vec![Command::Line {
                aa: false,
                from: [8.0, 32.5],
                to: [136.0, 32.5],
                colour: c,
                width: -1.0,
            }],
            vec![],
        ),
        &no_tables(),
    );
    assert_eq!(shortcut(&l, Shortcut::HairlineAsQuads), 1);
    // A 1-px quad centred on the segment: rows [32, 33), columns [8, 136).
    let ys: Vec<f32> = l.verts.iter().map(|v| v.pos[1]).collect();
    assert!(ys.contains(&32.0) && ys.contains(&33.0));
}

#[test]
fn nine_patch_tile_repeats_the_middle_per_period() {
    // A 12x12 texture with 4-texel margins: an 4-texel middle period. Draw 4 + 10 + 4 = 18 wide.
    let mut t = HashMap::new();
    t.insert(7, (12, 12));
    let tables = Tables { textures: t };
    let np = |axis: Axis| {
        lower::lower(
            &commands(
                vec![Command::NinePatch {
                    tex: Some(7),
                    rect: [0.0, 0.0, 18.0, 12.0],
                    source: [0.0; 4],
                    margins: [4.0, 4.0, 4.0, 4.0],
                    x_axis: axis,
                    y_axis: Axis::Stretch,
                    draw_center: true,
                    modulate: [1.0; 4],
                }],
                vec![],
            ),
            &tables,
        )
    };
    let stretch = np(Axis::Stretch);
    let tile = np(Axis::Tile);
    let fit = np(Axis::TileFit);
    // Stretch: 3x3 cells. Tile: 10 px of middle in periods of 4 -> 3 columns (4, 4, 2).
    assert_eq!(stretch.verts.len(), 9 * 4);
    assert_eq!(tile.verts.len(), (2 + 3) * 3 * 4);
    // Tile fit: floor(10 / 4 + 0.5) = 3 periods of 10/3 px.
    assert_eq!(fit.verts.len(), (2 + 3) * 3 * 4);
    assert_eq!(shortcut(&tile, Shortcut::NinePatchTileAsStretch), 0);
    // Every tile column restarts at the margin's texel: u = 4/12 at its left edge.
    let lefts: Vec<f32> = tile
        .verts
        .chunks(4)
        .filter(|q| q[0].pos[0] >= 4.0 && q[0].pos[0] < 14.0)
        .map(|q| q[0].uv[0])
        .collect();
    assert!(lefts.iter().all(|u| (*u - 4.0 / 12.0).abs() < 1e-6));
    // The sabotage draws every axis as stretch.
    let ignored = lower::lower_with(
        &commands(
            vec![Command::NinePatch {
                tex: Some(7),
                rect: [0.0, 0.0, 18.0, 12.0],
                source: [0.0; 4],
                margins: [4.0, 4.0, 4.0, 4.0],
                x_axis: Axis::Tile,
                y_axis: Axis::Tile,
                draw_center: true,
                modulate: [1.0; 4],
            }],
            vec![],
        ),
        &tables,
        LowerSabotage {
            ignore_nine_patch_axis: true,
            ..LowerSabotage::default()
        },
    );
    assert_eq!(ignored.verts.len(), 9 * 4);
}

#[test]
fn msdf_draws_as_a_flagged_region_and_drop_msdf_skips_it() {
    // G7tm: canvas_item_add_msdf_texture_rect_region is a region rect (renderer_canvas_cull.cpp
    // 1544-1576) whose draw carries [px_range, outline / scale / 4] (rasterizer_canvas_gles3.cpp
    // 999-1004). A flipped destination flips the quad as a plain region does.
    let mut t = HashMap::new();
    t.insert(3, (64, 32));
    let tables = Tables { textures: t };
    let msdf = |outline: i64, rect: [f32; 4], scale: f32| Command::MsdfTextureRectRegion {
        tex: Some(3),
        outline,
        rect,
        src: [8.0, 4.0, 16.0, 8.0],
        modulate: [1.0, 0.5, 0.25, 1.0],
        px_range: 24.0,
        scale,
    };
    let cmds = commands(
        vec![
            msdf(0, [4.0, 4.0, 10.0, 12.0], 0.5),
            msdf(4, [-2.0, 6.0, -10.0, 12.0], 1.5),
        ],
        vec![],
    );
    let l = lower::lower(&cmds, &tables);
    assert!(l.shortcuts.is_empty(), "{:?}", l.shortcuts);
    assert_eq!(l.draws.len(), 2);
    assert_eq!(l.draws[0].msdf, Some([24.0, 0.0]));
    // (float)4 / 1.5f / 4.0, in f32.
    assert_eq!(l.draws[1].msdf, Some([24.0, 4.0f32 / 1.5f32 / 4.0]));
    assert_eq!(l.draws[0].tex, lower::TexRef::Wire(3));
    assert_eq!(l.texture_deps, vec![3]);
    // The plain region's quad: src scaled by 1/size, vertex order (0,0) (0,1) (1,1) (1,0).
    let uv: Vec<[f32; 2]> = l.verts[..4].iter().map(|v| v.uv).collect();
    assert_eq!(
        uv,
        vec![
            [0.125, 0.125],
            [0.125, 0.375],
            [0.375, 0.375],
            [0.375, 0.125]
        ]
    );
    let pos: Vec<[f32; 2]> = l.verts[..4].iter().map(|v| v.pos).collect();
    assert_eq!(
        pos,
        vec![[4.0, 4.0], [4.0, 16.0], [14.0, 16.0], [14.0, 4.0]]
    );
    assert_eq!(l.verts[0].color, [1.0, 0.5, 0.25, 1.0]);
    // The negative width flips H and is made positive with the position kept (as
    // canvas_item_add_msdf_texture_rect_region does): (-2, 6, 10, 12), the vertices mirrored.
    let pos: Vec<[f32; 2]> = l.verts[4..8].iter().map(|v| v.pos).collect();
    assert_eq!(
        pos,
        vec![[8.0, 6.0], [8.0, 18.0], [-2.0, 18.0], [-2.0, 6.0]]
    );
    assert_eq!(l.rect, [-2.0, 4.0, 16.0, 14.0]);

    let half = lower::lower_with(
        &cmds,
        &tables,
        LowerSabotage {
            msdf_px_range: true,
            ..LowerSabotage::default()
        },
    );
    assert_eq!(half.draws[0].msdf, Some([12.0, 0.0]));

    let dropped = lower::lower_with(
        &cmds,
        &tables,
        LowerSabotage {
            drop_msdf: true,
            ..LowerSabotage::default()
        },
    );
    assert!(dropped.draws.is_empty());
    assert!(dropped.shortcuts.is_empty());
    assert_eq!(dropped.rect, [-2.0, 4.0, 16.0, 14.0]);
    assert_eq!(dropped.texture_deps, vec![3]);
}

#[test]
fn polygon_winding_sabotage_fans_the_reversed_contour() {
    // A concave arrow: ear clipping and a fan over the reversed contour cover different areas.
    let pts: Vec<f32> = vec![
        8.0, 16.0, 40.0, 16.0, 40.0, 8.0, 64.0, 25.0, 40.0, 42.0, 40.0, 33.0, 8.0, 33.0,
    ];
    let mut f32s = pts;
    f32s.extend_from_slice(&[0.8, 0.4, 1.0, 1.0]);
    let cmds = commands(
        vec![Command::Polygon {
            tex: None,
            points: Span { start: 0, len: 7 },
            colors: Span { start: 14, len: 1 },
            uvs: Span { start: 0, len: 0 },
        }],
        f32s,
    );
    let honest = lower::lower(&cmds, &no_tables());
    let sab = lower::lower_with(
        &cmds,
        &no_tables(),
        LowerSabotage {
            polygon_winding: true,
            ..LowerSabotage::default()
        },
    );
    assert_eq!(honest.idx.len(), sab.idx.len());
    assert_ne!(honest.idx, sab.idx);
    assert_eq!(&sab.idx[..3], &[6, 5, 4]);
}

fn surface(points: &[[f32; 2]], colour: u8) -> MeshGeometry {
    let vertex: Vec<u8> = points
        .iter()
        .flat_map(|p| p.iter().flat_map(|v| v.to_le_bytes()))
        .collect();
    let attribute: Vec<u8> = points
        .iter()
        .flat_map(|_| [colour, colour, colour, 255])
        .collect();
    mesh_geometry(
        Primitive::Triangles,
        1 | (1 << 3),
        [0.0; 6],
        points.len(),
        0,
        MeshBuffers {
            vertex: &vertex,
            attribute: &attribute,
            skin: &[],
            index: &[],
            uv_scale: [0.0; 4],
        },
    )
    .unwrap()
}

fn item_with(id: Id, commands: Commands) -> Item {
    Item {
        id,
        origin: Origin::Created,
        parent: None,
        children: Vec::new(),
        visible: true,
        draw_index: id as i64,
        z_index: 0,
        z_relative: true,
        behind: false,
        clip: false,
        custom_rect: false,
        visibility_layer: 1,
        texture_filter: Filter::Default,
        texture_repeat: Repeat::Default,
        material: None,
        use_parent_material: false,
        instance_params: Vec::new(),
        canvas_group: None,
        copy_to_backbuffer: None,
        content_version: 1,
        xform: geom::IDENTITY,
        modulate: [1.0; 4],
        self_modulate: [1.0; 4],
        custom_rect_rect: [0.0; 4],
        commands,
    }
}

fn hash(n: u8) -> Hash {
    Hash([n; 32])
}

fn mesh_state(surfaces: &[(u8, usize)]) -> ResolvedState {
    let mut s = ResolvedState::empty(6);
    s.meshes.insert(
        5,
        Mesh {
            id: 5,
            origin: Origin::Created,
            adopted_content: None,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            custom_aabb: [0.0; 6],
            surfaces: surfaces
                .iter()
                .map(|(h, n)| MeshSurface {
                    hash: Some(hash(*h)),
                    body_sha256: None,
                    payload_bytes: 0,
                    primitive: Primitive::Triangles,
                    format: 1 | (1 << 3),
                    vertex_count: *n as i64,
                    index_count: 0,
                })
                .collect(),
        },
    );
    s.items.insert(
        9,
        item_with(
            9,
            commands(
                vec![Command::Mesh {
                    mesh: 5,
                    tex: None,
                    transform: geom::IDENTITY,
                    modulate: [1.0; 4],
                }],
                vec![],
            ),
        ),
    );
    s
}

#[test]
fn mesh_residency_writes_the_native_census_rows() {
    let tri = [[0.0, 0.0], [8.0, 0.0], [0.0, 8.0]];
    let quad = [
        [0.0, 0.0],
        [8.0, 0.0],
        [0.0, 8.0],
        [8.0, 0.0],
        [8.0, 8.0],
        [0.0, 8.0],
    ];
    let mut store = PayloadStore::default();
    store.meshes.insert(hash(1), surface(&tri, 51));
    store.meshes.insert(hash(2), surface(&tri, 102)); // same layout, other colour
    store.meshes.insert(hash(3), surface(&quad, 51)); // another layout
    store.meshes.insert(hash(4), surface(&tri, 204));
    let rows = |r: &MeshResidency| -> Vec<(&'static str, Vec<u32>, Vec<&'static str>, u64)> {
        r.uploads
            .iter()
            .map(|u| (u.op, u.surfaces.clone(), u.buffers.clone(), u.bytes))
            .collect()
    };
    let mut r = MeshResidency::default();
    // Named at first: create, every surface.
    let s = mesh_state(&[(1, 3), (4, 3)]);
    r.sync(&s, &[9], &[], true, &store);
    assert_eq!(
        rows(&r),
        vec![("create", vec![0, 1], vec![], 2 * (24 + 12))]
    );
    // Surface 0's colours change: an in-place update of the attribute buffer only.
    let s = mesh_state(&[(2, 3), (4, 3)]);
    r.sync(&s, &[], &[], false, &store);
    assert_eq!(rows(&r), vec![("update", vec![0], vec!["attribute"], 12)]);
    // A layout change rebuilds.
    let s = mesh_state(&[(3, 6), (4, 3)]);
    r.sync(&s, &[], &[], false, &store);
    assert_eq!(
        rows(&r),
        vec![("rebuild", vec![0, 1], vec![], 48 + 24 + 24 + 12)]
    );
    // Leaving the table frees.
    let mut s = mesh_state(&[(3, 6), (4, 3)]);
    s.meshes.clear();
    r.sync(&s, &[], &[], false, &store);
    assert_eq!(rows(&r), vec![("free", vec![], vec![], 0)]);

    // drop-mesh-surface: surface 1 is never added (nor drawn); stale-mesh: updates are ignored.
    let mut d = MeshResidency::default();
    d.sabotage = MeshSabotage {
        drop_surface: true,
        stale: false,
    };
    d.sync(&mesh_state(&[(1, 3), (4, 3)]), &[9], &[], true, &store);
    assert_eq!(rows(&d), vec![("create", vec![0], vec![], 24 + 12)]);
    assert_eq!(d.drawn(5, &store).unwrap().0.len(), 1);
    let mut st = MeshResidency::default();
    st.sabotage = MeshSabotage {
        drop_surface: false,
        stale: true,
    };
    st.sync(&mesh_state(&[(1, 3)]), &[9], &[], true, &store);
    st.sync(&mesh_state(&[(2, 3)]), &[], &[], false, &store);
    assert!(st.uploads.is_empty());
    let (drawn, _) = st.drawn(5, &store).unwrap();
    assert_eq!(drawn[0].colors.as_ref().unwrap()[0][0], 51.0 / 255.0);
}
