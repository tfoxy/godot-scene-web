use super::oracle::provenance;
use super::*;
use crate::{Binding, Item, Sampler, Target, Uniform, UniformValue, Vertex, DRAW_SCREEN_OPS};
use std::collections::HashMap;

#[derive(Default)]
struct Facts {
    opacity: HashMap<u32, Opacity>,
    programs: Vec<ProgramFacts>,
    max_side: u32,
}

impl CoverFacts for Facts {
    fn opacity(&self, texture: u32) -> Option<&Opacity> {
        self.opacity.get(&texture)
    }
    fn program(&self, slot: u32) -> ProgramFacts {
        self.programs
            .get(slot as usize)
            .copied()
            .unwrap_or(ProgramFacts::UNKNOWN)
    }
    fn max_texture_side(&self) -> u32 {
        self.max_side
    }
}

/// A 64×64 texture, opaque except a transparent 2-texel frame (an atlas region at 2..62), or with
/// `hole` translucent.
fn atlas(hole: Option<(u32, u32)>) -> Opacity {
    let mut px = vec![255u8; 64 * 64 * 4];
    for y in 0..64u32 {
        for x in 0..64u32 {
            let frame = !(2..62).contains(&x) || !(2..62).contains(&y);
            if frame || hole == Some((x, y)) {
                px[(4 * (y * 64 + x) + 3) as usize] = 0;
            }
        }
    }
    Opacity::from_rgba8(64, 64, &px)
}

struct L {
    list: DrawList,
}

impl L {
    fn new(opaque: bool) -> L {
        L::sized(100, 50, opaque)
    }

    fn sized(width: u32, height: u32, opaque: bool) -> L {
        L {
            list: DrawList::new(Target {
                width,
                height,
                opaque,
                ..Target::default()
            }),
        }
    }

    /// One draw: item `xform`, modulate alpha `alpha`, the quad `r` (item space) split into
    /// `nx × ny` cells of two triangles each, texture coordinates `uv` across it.
    #[allow(clippy::too_many_arguments)]
    fn grid(
        &mut self,
        xform: [f32; 6],
        r: [f32; 4],
        nx: u32,
        ny: u32,
        uv: [f32; 4],
        texture: u32,
        blend: Blend,
        alpha: f32,
    ) -> usize {
        let l = &mut self.list;
        let item = l.items.len() as u32;
        l.items.push(Item {
            xform,
            modulate: [1.0, 1.0, 1.0, alpha],
            ..Item::default()
        });
        let base = l.vertices.len() as u32;
        for j in 0..=ny {
            for i in 0..=nx {
                let (fx, fy) = (i as f32 / nx as f32, j as f32 / ny as f32);
                l.vertices.push(Vertex {
                    pos: [r[0] + (r[2] - r[0]) * fx, r[1] + (r[3] - r[1]) * fy],
                    uv: [uv[0] + (uv[2] - uv[0]) * fx, uv[1] + (uv[3] - uv[1]) * fy],
                    color: [1.0; 4],
                    item,
                });
            }
        }
        let first = l.indices.len() as u32;
        for j in 0..ny {
            for i in 0..nx {
                let v = |a: u32, b: u32| base + b * (nx + 1) + a;
                l.indices.extend([
                    v(i, j),
                    v(i + 1, j),
                    v(i + 1, j + 1),
                    v(i, j),
                    v(i + 1, j + 1),
                    v(i, j + 1),
                ]);
            }
        }
        l.draws.push(Draw {
            first_index: first,
            index_count: 6 * nx * ny,
            texture,
            sampler: Sampler::LINEAR,
            blend: blend as u32,
            flags: if texture == WHITE_TEXTURE {
                DRAW_UNTEXTURED
            } else {
                0
            },
            ..Draw::default()
        });
        l.draws.len() - 1
    }

    fn rect(&mut self, r: [f32; 4], blend: Blend, alpha: f32) -> usize {
        self.grid(
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            r,
            1,
            1,
            [0.0, 0.0, 1.0, 1.0],
            WHITE_TEXTURE,
            blend,
            alpha,
        )
    }

    fn op(&mut self, before: usize, kind: ScreenOpKind, region: [i32; 4], mipmaps: bool) {
        self.list.screen_ops.push(ScreenOp {
            before: before as u32,
            kind,
            region,
            mipmaps,
            sample_mips: mipmaps,
        });
        self.list.draws[before].flags |= DRAW_SCREEN_OPS;
    }
}

const ID: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// Runs the walk; checks that the culled list paints what the full list paints (the oracle) and
/// returns the kept draws and operations.
fn walk(l: &L, facts: &Facts) -> (Vec<bool>, Vec<bool>) {
    // The cases are small: analyse every draw.
    let mut w = CoverWalk {
        min_cover_area: 0,
        ..CoverWalk::default()
    };
    w.run(&l.list, facts);
    let mut culled = l.list.clone();
    w.compact(
        &l.list.draws,
        &l.list.screen_ops,
        &l.list.instanced,
        &mut culled.draws,
        &mut culled.screen_ops,
        &mut culled.instanced,
    );
    let full = provenance(&l.list, facts);
    let cut = provenance(&culled, facts);
    if full.mismatches(&cut) != 0 {
        let bad: Vec<(usize, usize)> = (0..full.rgb.len())
            .filter(|&i| full.rgb[i] != cut.rgb[i] || full.alpha[i] != cut.alpha[i])
            .map(|i| (i % full.width as usize, i / full.width as usize))
            .take(12)
            .collect();
        panic!(
            "the culled list paints differently at {bad:?} (keep {:?})",
            w.keep_draw
        );
    }
    (w.keep_draw.clone(), w.keep_op.clone())
}

#[test]
fn a_full_screen_rect_hides_what_lies_under_it() {
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    l.rect([20.0, 20.0, 40.0, 40.0], Blend::Mix, 0.5);
    let (k, _) = walk(&l, &Facts::default());
    assert_eq!(k, [false, true, true]);
}

#[test]
fn a_rect_that_misses_one_pixel_centre_does_not_hide() {
    // The cover's left edge at x = 10.5 leaves pixel 10 (centre 10.5) unclaimed; the draw
    // under it reaches pixel 10.
    let mut l = L::new(false);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    l.rect([10.5, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    let (k, _) = walk(&l, &Facts::default());
    assert_eq!(k, [true, true]);
    // From 10.4 the centre 10.5 is inside by less than the margin: still kept.
    l.list.vertices[4].pos[0] = 10.45;
    l.list.vertices[6].pos[0] = 10.45;
    assert_eq!(walk(&l, &Facts::default()).0, [true, true]);
    // From 10.4 it is inside by more: dropped.
    l.list.vertices[4].pos[0] = 10.4;
    l.list.vertices[6].pos[0] = 10.4;
    assert_eq!(walk(&l, &Facts::default()).0, [false, true]);
}

#[test]
fn translucent_or_non_mix_covers_hide_nothing() {
    for (blend, alpha) in [
        (Blend::Mix, 0.99),
        (Blend::PremulAlpha, 0.99),
        (Blend::Add, 1.0),
        (Blend::Sub, 1.0),
        (Blend::Mul, 1.0),
    ] {
        for opaque in [true, false] {
            let mut l = L::new(opaque);
            l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
            l.rect([0.0, 0.0, 100.0, 50.0], blend, alpha);
            assert_eq!(
                walk(&l, &Facts::default()).0,
                [true, true],
                "{blend:?} {alpha}"
            );
        }
    }
    // A translucent vertex colour.
    let mut l = L::new(false);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    l.list.vertices[5].color[3] = 0.999;
    assert_eq!(walk(&l, &Facts::default()).0, [true, true]);
}

#[test]
fn disabled_overwrites_and_premultiplied_alpha_covers() {
    let mut l = L::new(false);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::Disabled, 0.2);
    assert_eq!(walk(&l, &Facts::default()).0, [false, true]);
    let mut l = L::new(false);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::PremulAlpha, 1.0);
    assert_eq!(walk(&l, &Facts::default()).0, [false, true]);
}

#[test]
fn on_an_opaque_target_a_mix_cover_keeps_what_writes_alpha_beneath() {
    // GLES3 keeps the destination alpha for every blend but disabled on the root target: a
    // disabled draw's alpha under a mix cover survives it.
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Disabled, 0.5);
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    assert_eq!(walk(&l, &Facts::default()).0, [true, true]);
    // On a transparent target the mix cover writes alpha 1 there too.
    let mut l = L::new(false);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Disabled, 0.5);
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    assert_eq!(walk(&l, &Facts::default()).0, [false, true]);
    // A disabled cover writes alpha on the opaque target as well.
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Disabled, 0.5);
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::Disabled, 1.0);
    assert_eq!(walk(&l, &Facts::default()).0, [false, true]);
}

#[test]
fn a_rotated_rect_hides_what_lies_inside_its_inscribed_rect() {
    let mut l = L::new(true);
    l.rect([45.0, 20.0, 55.0, 30.0], Blend::Mix, 0.5);
    l.rect([5.0, 5.0, 15.0, 15.0], Blend::Mix, 0.5);
    // A 60×60 square rotated 30° about (50, 25).
    let (s, c) = (30f32.to_radians().sin(), 30f32.to_radians().cos());
    l.grid(
        [c, s, -s, c, 50.0, 25.0],
        [-30.0, -30.0, 30.0, 30.0],
        1,
        1,
        [0.0; 4],
        WHITE_TEXTURE,
        Blend::Mix,
        1.0,
    );
    // The centre square is inside; the corner one is not.
    assert_eq!(walk(&l, &Facts::default()).0, [false, true, true]);
}

#[test]
fn a_triangulated_mesh_hides_what_its_cells_tile() {
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 90.0, 40.0], Blend::Mix, 0.5);
    // 7×3 cells: 42 triangles over the whole target, past its edges.
    l.grid(
        [2.0, 0.0, 0.0, 2.0, -10.0, -5.0],
        [0.0, 0.0, 60.0, 30.0],
        7,
        3,
        [0.0; 4],
        WHITE_TEXTURE,
        Blend::Mix,
        1.0,
    );
    assert_eq!(l.list.draws[1].index_count, 126);
    assert_eq!(walk(&l, &Facts::default()).0, [false, true]);
    // A cell missing (a hole): nothing is claimed.
    let mut holed = L::new(true);
    holed.rect([10.0, 10.0, 90.0, 40.0], Blend::Mix, 0.5);
    holed.grid(
        [2.0, 0.0, 0.0, 2.0, -10.0, -5.0],
        [0.0, 0.0, 60.0, 30.0],
        7,
        3,
        [0.0; 4],
        WHITE_TEXTURE,
        Blend::Mix,
        1.0,
    );
    let d = &mut holed.list.draws[1];
    let cell = 6 * 10;
    let first = d.first_index as usize;
    holed.list.indices.drain(first + cell..first + cell + 6);
    holed.list.draws[1].index_count -= 6;
    assert_eq!(walk(&holed, &Facts::default()).0, [true, true]);
    // A T-junction (a vertex moved onto a neighbour's edge but not shared): no claim.
    let mut t = L::new(true);
    t.rect([10.0, 10.0, 90.0, 40.0], Blend::Mix, 0.5);
    t.grid(
        [2.0, 0.0, 0.0, 2.0, -10.0, -5.0],
        [0.0, 0.0, 60.0, 30.0],
        2,
        1,
        [0.0; 4],
        WHITE_TEXTURE,
        Blend::Mix,
        1.0,
    );
    // Split the right cell's bottom edge with a vertex the left cell does not have.
    let v = t.list.vertices.len() as u32;
    let base = v - 6;
    t.list.vertices.push(Vertex {
        pos: [30.0, 15.0],
        ..t.list.vertices[base as usize]
    });
    // Right cell: (1,0)=base+1 (2,0)=base+2 (2,1)=base+5 (1,1)=base+4; replace its triangles
    // with a fan through the new vertex on its left edge.
    let first = t.list.draws[1].first_index as usize;
    t.list.indices.truncate(first + 6);
    t.list.indices.extend([
        base + 1,
        base + 2,
        v,
        base + 2,
        base + 5,
        v,
        v,
        base + 5,
        base + 4,
    ]);
    t.list.draws[1].index_count = 15;
    assert_eq!(walk(&t, &Facts::default()).0, [true, true]);
}

#[test]
fn an_atlas_region_covers_when_every_sampled_texel_is_opaque() {
    let mut facts = Facts::default();
    facts.opacity.insert(7, atlas(None));
    // Texture coordinates from texel 3 to 61 (inside the opaque 2..62 with the filter margin).
    let uv = [3.0 / 64.0, 3.0 / 64.0, 61.0 / 64.0, 61.0 / 64.0];
    let build = |uv: [f32; 4]| {
        let mut l = L::new(true);
        l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
        l.grid(ID, [0.0, 0.0, 100.0, 50.0], 1, 1, uv, 7, Blend::Mix, 1.0);
        l
    };
    assert_eq!(walk(&build(uv), &facts).0, [false, true]);
    // Reaching texel 2 at the edge: linear filtering there reads texel 1 (transparent).
    let edge = [2.0 / 64.0, 3.0 / 64.0, 61.0 / 64.0, 61.0 / 64.0];
    assert_eq!(walk(&build(edge), &facts).0, [true, true]);
    // The same with the geometry past the target's left edge: the pixels that would read texel
    // 1 are off the target, so it covers again.
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    l.grid(ID, [-5.0, 0.0, 100.0, 50.0], 1, 1, edge, 7, Blend::Mix, 1.0);
    assert_eq!(walk(&l, &facts).0, [false, true]);
    // One translucent texel inside the region.
    facts.opacity.insert(7, atlas(Some((30, 30))));
    assert_eq!(walk(&build(uv), &facts).0, [true, true]);
    // Repeat reaches the texture's transparent frame.
    facts.opacity.insert(7, atlas(None));
    let mut l = build(uv);
    l.list.draws[1].sampler = Sampler::LINEAR | Sampler::REPEAT;
    assert_eq!(
        walk(&l, &facts).0,
        [false, true],
        "inside the texture: no wrap"
    );
    l.list
        .vertices
        .iter_mut()
        .skip(4)
        .for_each(|v| v.uv[0] = 0.0);
    assert_eq!(walk(&l, &facts).0, [true, true]);
    // An unknown texture never covers.
    let mut l = build(uv);
    l.list.draws[1].texture = 8;
    assert_eq!(walk(&l, &facts).0, [true, true]);
}

#[test]
fn a_custom_program_never_covers_and_a_scissor_cuts_the_claim() {
    let mut facts = Facts::default();
    facts.programs.push(ProgramFacts {
        reads_screen: false,
        vertex_stage: false,
        alpha: None,
    });
    let mut l = L::new(true);
    l.list.bindings.push(Binding {
        program: 1,
        post_modulate: [1.0; 4],
        uniforms: Vec::new(),
        samplers: Vec::new(),
    });
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    let c = l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    l.list.draws[c].program = 1;
    l.list.draws[c].flags &= !DRAW_UNTEXTURED;
    assert_eq!(walk(&l, &facts).0, [true, true]);
    // A scissored cover claims only inside its scissor.
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    let c = l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    l.list.draws[c].flags |= DRAW_SCISSOR;
    l.list.draws[c].scissor = [0, 0, 25, 50];
    assert_eq!(walk(&l, &facts).0, [true, true]);
    l.list.draws[c].scissor = [0, 0, 30, 50];
    assert_eq!(walk(&l, &facts).0, [false, true]);
}

#[test]
fn a_screen_copy_and_its_mips_go_only_with_every_reader() {
    let mut facts = Facts::default();
    facts.programs.push(ProgramFacts {
        reads_screen: true,
        vertex_stage: false,
        alpha: None,
    });
    let binding = Binding {
        program: 1,
        post_modulate: [1.0; 4],
        uniforms: Vec::new(),
        samplers: Vec::new(),
    };
    // background, a full-screen blur reader (copy + mips before it), an opaque full-screen
    // cover, then (optionally) a second reader of the same copy after the cover.
    let build = |second: bool| {
        let mut l = L::new(true);
        l.list.bindings.push(binding.clone());
        l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 0.7);
        let r = l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
        l.list.draws[r].program = 1;
        l.list.draws[r].flags &= !DRAW_UNTEXTURED;
        l.op(r, ScreenOpKind::Copy, [0, 0, 100, 50], true);
        l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
        if second {
            let r2 = l.rect([20.0, 20.0, 40.0, 40.0], Blend::Mix, 1.0);
            l.list.draws[r2].program = 1;
            l.list.draws[r2].flags &= !DRAW_UNTEXTURED;
        }
        l
    };
    let (k, o) = walk(&build(false), &facts);
    assert_eq!(k, [false, false, true]);
    assert_eq!(o, [false], "the copy and its mips have no reader left");
    let (k, o) = walk(&build(true), &facts);
    // The reader after the cover still reads the copy: it stays, and so does what it copied.
    assert_eq!(k, [true, false, true, true]);
    assert_eq!(o, [true]);
}

#[test]
fn a_canvas_group_goes_only_when_its_composite_is_covered() {
    // A clip group: a copy of its rect, its draws into the back buffer, its composite.
    let build = |cover_over_group: bool| {
        let mut l = L::new(true);
        l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 0.6);
        let g = l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 1.0);
        l.list.draws[g].flags |= DRAW_TO_BACK_BUFFER;
        l.op(g, ScreenOpKind::Copy, [10, 10, 20, 20], false);
        let c = l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 1.0);
        l.list.draws[c].flags |= DRAW_GROUP_CLIP;
        if cover_over_group {
            l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
        } else {
            l.rect([50.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
        }
        l
    };
    let (k, o) = walk(&build(true), &Facts::default());
    assert_eq!(k, [false, false, false, true]);
    assert_eq!(o, [false]);
    let (k, o) = walk(&build(false), &Facts::default());
    assert_eq!(k, [true, true, true, true]);
    assert_eq!(o, [true]);
}

#[test]
fn a_back_buffer_draw_is_not_hidden_by_a_target_cover() {
    // A transparent group (clear, draws into the back buffer, composite) entirely under a cover
    // that comes BEFORE the composite reads: the target cover hides nothing in the back buffer.
    let mut l = L::new(false);
    let g = l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    l.list.draws[g].flags |= DRAW_TO_BACK_BUFFER;
    l.op(g, ScreenOpKind::Clear, [0, 0, 100, 50], false);
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    let c = l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 1.0);
    l.list.draws[c].flags |= DRAW_GROUP_COMPOSITE;
    let (k, o) = walk(&l, &Facts::default());
    assert_eq!(k, [true, true, true]);
    assert_eq!(o, [true]);
}

#[test]
fn compaction_moves_kept_operations_and_renumbers() {
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    let r = l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    // A copy before the hidden draw, read by a group composite after the cover.
    l.op(r, ScreenOpKind::Copy, [60, 10, 20, 20], false);
    l.rect([0.0, 0.0, 50.0, 50.0], Blend::Mix, 1.0);
    let g = l.rect([60.0, 10.0, 80.0, 30.0], Blend::Mix, 1.0);
    l.list.draws[g].flags |= DRAW_TO_BACK_BUFFER;
    let c = l.rect([60.0, 10.0, 80.0, 30.0], Blend::Mix, 1.0);
    l.list.draws[c].flags |= DRAW_GROUP_CLIP;
    let mut w = CoverWalk {
        min_cover_area: 0,
        ..CoverWalk::default()
    };
    assert!(w.run(&l.list, &Facts::default()));
    assert_eq!(w.keep_draw, [false, false, true, true, true]);
    assert_eq!(w.keep_op, [true]);
    let (mut d, mut o, mut i) = (Vec::new(), Vec::new(), Vec::new());
    w.compact(
        &l.list.draws,
        &l.list.screen_ops,
        &[],
        &mut d,
        &mut o,
        &mut i,
    );
    assert_eq!(d.len(), 3);
    assert_eq!(o[0].before, 0);
    assert_ne!(d[0].flags & DRAW_SCREEN_OPS, 0);
    assert!(d[1..].iter().all(|x| x.flags & DRAW_SCREEN_OPS == 0));
    walk(&l, &Facts::default());
}

#[test]
fn the_oracle_sees_a_wrong_drop() {
    // Dropping a draw a pixel still depends on changes that pixel's provenance.
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    l.rect([10.5, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    let mut culled = l.list.clone();
    culled.draws.remove(0);
    let f = Facts::default();
    assert!(provenance(&l.list, &f).mismatches(&provenance(&culled, &f)) > 0);
}

#[test]
fn a_deformed_mesh_past_every_edge_hides_the_whole_target() {
    // A 7×3 grid whose inner vertices wobble (a background mesh), reaching past the target.
    let build = |reach: f32| {
        let mut l = L::new(true);
        l.rect([10.0, 10.0, 90.0, 40.0], Blend::Mix, 0.5);
        l.grid(
            ID,
            [-reach, -reach, 100.0 + reach, 50.0 + reach],
            7,
            3,
            [0.0; 4],
            WHITE_TEXTURE,
            Blend::Mix,
            1.0,
        );
        let base = l.list.vertices.len() - 32;
        for (k, v) in l.list.vertices[base..].iter_mut().enumerate() {
            let (i, j) = (k % 8, k / 8);
            if (1..7).contains(&i) && (1..3).contains(&j) {
                v.pos[0] += if k % 2 == 0 { 1.5 } else { -1.25 };
                v.pos[1] += if k % 3 == 0 { -0.75 } else { 1.0 };
            }
        }
        l
    };
    assert_eq!(walk(&build(8.0), &Facts::default()).0, [false, true]);
    // With its boundary on the target, the general test fails and the grid tiles no rectangle.
    let mut l = build(8.0);
    let base = l.list.vertices.len() - 32;
    l.list.vertices[base + 3].pos[1] = 2.0;
    assert_eq!(walk(&l, &Facts::default()).0, [true, true]);
}

#[test]
fn a_cover_smaller_than_the_minimum_area_is_not_analysed() {
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 20.0, 20.0], Blend::Mix, 0.5);
    l.rect([0.0, 0.0, 30.0, 30.0], Blend::Mix, 1.0);
    let mut w = CoverWalk::default();
    assert!(
        !w.run(&l.list, &Facts::default()),
        "900 px is below the default 4096"
    );
    w.min_cover_area = 900;
    assert!(w.run(&l.list, &Facts::default()));
}

#[test]
fn the_memo_follows_what_the_dirty_ranges_say_changed() {
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 20.0, 20.0], Blend::Mix, 0.5);
    l.rect([0.0, 0.0, 50.0, 50.0], Blend::Mix, 1.0);
    let f = Facts::default();
    let mut w = CoverWalk {
        min_cover_area: 0,
        ..CoverWalk::default()
    };
    assert!(w.run(&l.list, &f));
    l.list.consumed();
    assert!(w.run(&l.list, &f), "nothing changed: the same answer");
    // The cover's row moves right by 50 (its row marked, as an applier marks it).
    l.list.items[1].xform[4] = 50.0;
    l.list.dirty.items.add(1, 2);
    assert!(!w.run(&l.list, &f));
    l.list.consumed();
    // A vertex of the hidden rect moves out from under it... the cover is back first.
    l.list.items[1].xform[4] = 0.0;
    l.list.dirty.items.add(1, 2);
    assert!(w.run(&l.list, &f));
    l.list.consumed();
    l.list.vertices[1].pos[0] = 60.0;
    l.list.dirty.vertices.add(1, 2);
    assert!(!w.run(&l.list, &f), "the rect now reaches past the cover");
    l.list.consumed();
    // A texture upload of the cover's texture re-reads its opacity.
    let mut facts = Facts::default();
    facts.opacity.insert(7, atlas(None));
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 20.0, 20.0], Blend::Mix, 0.5);
    let uv = [3.0 / 64.0, 3.0 / 64.0, 61.0 / 64.0, 61.0 / 64.0];
    l.grid(ID, [0.0, 0.0, 100.0, 50.0], 1, 1, uv, 7, Blend::Mix, 1.0);
    assert!(w.run(&l.list, &facts));
    l.list.consumed();
    facts.opacity.insert(7, atlas(Some((30, 30))));
    l.list.upload_texture(7, 1, 1, &[0, 0, 0, 0]);
    assert!(!w.run(&l.list, &facts));
}

#[test]
fn spans_meet_overlapping_and_unsorted_ranges() {
    let mut r = crate::Ranges::default();
    r.add(50, 60);
    r.add(0, 100);
    r.add(10, 12);
    let s = super::Spans::of(&r);
    assert!(s.meets(70, 71), "inside the long range added second");
    assert!(!s.meets(100, 120));
    assert!(s.meets(99, 120));
    assert!(!s.meets(5, 5), "empty");
}

#[test]
fn a_memo_the_walk_did_not_read_for_a_run_still_sees_what_changed_in_it() {
    let mut l = L::new(true);
    // Additive: never a cover, so only a cover in front makes the walk read its bounds.
    let a = l.rect([10.0, 10.0, 20.0, 20.0], Blend::Add, 1.0);
    let c = l.rect([0.0, 0.0, 50.0, 50.0], Blend::Mix, 1.0);
    let f = Facts::default();
    let mut w = CoverWalk {
        min_cover_area: 0,
        ..CoverWalk::default()
    };
    assert!(w.run(&l.list, &f));
    assert_eq!(w.keep_draw, [false, true]);
    l.list.consumed();
    // The cover turns translucent, so nothing reads the hidden rect's bounds, and meanwhile the
    // rect moves out from under where the cover will be.
    l.list.items[c].modulate[3] = 0.5;
    l.list.dirty.items.add(c as u32, c as u32 + 1);
    for v in &mut l.list.vertices[4 * a..4 * a + 4] {
        v.pos[0] += 50.0;
    }
    l.list.dirty.vertices.add(4 * a as u32, 4 * a as u32 + 4);
    assert!(!w.run(&l.list, &f));
    l.list.consumed();
    // The cover is back; only its row is dirty now, yet the rect it no longer hides stays.
    l.list.items[c].modulate[3] = 1.0;
    l.list.dirty.items.add(c as u32, c as u32 + 1);
    assert!(!w.run(&l.list, &f), "the rect lies past the cover now");
    assert_eq!(w.keep_draw, [true, true]);
}

#[test]
fn an_incremental_walk_answers_as_a_walk_that_remembers_nothing() {
    // A scene of covers (an opaque rect, a mix rect, an atlas grid, a rotated quad) over small
    // draws, a back-buffer copy and a screen reader; then random changes, each marked the way an
    // applier marks it (sometimes over a wider range than changed), and after each one the
    // incremental walk must keep exactly what a fresh walk keeps.
    let mut facts = Facts::default();
    facts.opacity.insert(7, atlas(None));
    // The reader's alpha is its uniform's (a no-op at 0).
    facts.programs.push(ProgramFacts {
        reads_screen: true,
        vertex_stage: false,
        alpha: Some(AlphaUniform {
            uniform: 0,
            component: 0,
        }),
    });
    let mut l = L::new(true);
    l.list.bindings.push(threshold_binding(0.5));
    let uv = [3.0 / 64.0, 3.0 / 64.0, 61.0 / 64.0, 61.0 / 64.0];
    for i in 0..6 {
        let x = 8.0 * i as f32;
        l.rect([x, 5.0, x + 6.0, 11.0], Blend::Mix, 0.5);
    }
    l.grid(ID, [0.0, 0.0, 60.0, 40.0], 3, 2, uv, 7, Blend::Mix, 1.0);
    l.rect([20.0, 20.0, 30.0, 30.0], Blend::Mix, 0.7);
    let reader = l.rect([40.0, 10.0, 60.0, 30.0], Blend::Mix, 0.5);
    l.list.draws[reader].program = 1;
    l.op(reader, ScreenOpKind::Copy, [0, 0, 100, 50], false);
    l.rect([30.0, 0.0, 100.0, 50.0], Blend::Disabled, 1.0);
    let s = std::f32::consts::FRAC_1_SQRT_2;
    l.grid(
        [s, s, -s, s, 50.0, 0.0],
        [0.0, 0.0, 30.0, 30.0],
        1,
        1,
        [0.0, 0.0, 1.0, 1.0],
        WHITE_TEXTURE,
        Blend::Mix,
        1.0,
    );
    for i in 0..4 {
        let x = 12.0 * i as f32;
        l.rect([x, 30.0, x + 9.0, 39.0], Blend::Mix, 0.3);
    }
    let n_items = l.list.items.len() as u32;
    let n_verts = l.list.vertices.len() as u32;
    let mut seed = 0x2545_f491_u32;
    let mut rnd = move |n: u32| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed % n
    };
    let mut w = CoverWalk {
        min_cover_area: 0,
        ..CoverWalk::default()
    };
    let (mut dropped, mut kept, mut noops) = (0, 0, 0);
    let n_draws = l.list.draws.len() as u32;
    for step in 0..1500 {
        match rnd(11) {
            // A row moves by up to a pixel, or jumps.
            0 => {
                let r = rnd(n_items);
                let d = if rnd(4) == 0 { 20.0 } else { 0.25 };
                l.list.items[r as usize].xform[4] += d * (rnd(3) as f32 - 1.0);
                l.list.items[r as usize].xform[5] += d * (rnd(3) as f32 - 1.0);
                l.list.dirty.items.add(r, r + 1);
            }
            // A modulate alpha cycles through opaque, translucent and zero.
            1 => {
                let r = rnd(n_items) as usize;
                let m = &mut l.list.items[r].modulate[3];
                *m = match *m {
                    1.0 => 0.6,
                    0.6 => 0.0,
                    _ => 1.0,
                };
                l.list.dirty.items.add(r as u32, r as u32 + 1);
            }
            // A vertex drifts; the dirty range sometimes covers far more than changed.
            2 => {
                let v = rnd(n_verts);
                l.list.vertices[v as usize].pos[rnd(2) as usize] += rnd(5) as f32 - 2.0;
                let (a, b) = if rnd(2) == 0 {
                    (v, v + 1)
                } else {
                    (v.saturating_sub(rnd(20)), (v + 1 + rnd(20)).min(n_verts))
                };
                l.list.dirty.vertices.add(a, b);
            }
            // Vertices are rewritten unchanged under a wide range.
            3 => l.list.dirty.vertices.add(0, n_verts),
            // The atlas is re-uploaded, with or without a hole the grid samples.
            4 => {
                let hole = (rnd(2) == 0).then_some((30, 30));
                facts.opacity.insert(7, atlas(hole));
                l.list.upload_texture(7, 1, 1, &[0, 0, 0, 0]);
            }
            // A vertex alpha drops, to zero, and comes back; or a whole draw's do.
            5 => {
                let v = rnd(n_verts) as usize;
                let a = &mut l.list.vertices[v].color[3];
                *a = match *a {
                    1.0 => 0.5,
                    0.5 => 0.0,
                    _ => 1.0,
                };
                l.list.dirty.vertices.add(v as u32, v as u32 + 1);
                if rnd(3) == 0 {
                    // The rect's four vertices, as an applier rewrites a recoloured item.
                    let first = v as u32 / 4 * 4;
                    let a = l.list.vertices[v].color[3];
                    for x in first..(first + 4).min(n_verts) {
                        l.list.vertices[x as usize].color[3] = a;
                    }
                    l.list.dirty.vertices.add(first, (first + 4).min(n_verts));
                }
            }
            // The reader's uniform goes to zero and back.
            6 => {
                let now = match &l.list.bindings[0].uniforms[0].value {
                    crate::UniformValue::Float(v) => v[0],
                    crate::UniformValue::Int(_) => unreachable!(),
                };
                let next = if now == 0.0 { 0.5 } else { 0.0 };
                l.list.set_binding(0, threshold_binding(next));
            }
            // The table changes at an equal count: two neighbours swap places (a z or tree reorder).
            8 => {
                let d = rnd(n_draws - 1) as usize;
                l.list.draws.swap(d, d + 1);
                // Screen operations stay where they were, before the same index.
                l.list.dirty.draws = true;
            }
            // A draw's blend changes (mix, add, mul).
            9 => {
                let d = rnd(n_draws) as usize;
                if l.list.draws[d].program == BUILTIN_PROGRAM {
                    l.list.draws[d].blend =
                        [Blend::Mix, Blend::Add, Blend::Mul][rnd(3) as usize] as u32;
                    l.list.dirty.draws = true;
                }
            }
            // A builtin draw takes the reader's program, or a program draw goes builtin.
            10 => {
                let d = rnd(n_draws) as usize;
                let draw = &mut l.list.draws[d];
                if draw.flags & DRAW_SCREEN_OPS == 0 {
                    if draw.program == BUILTIN_PROGRAM {
                        draw.program = 1;
                        draw.flags &= !DRAW_UNTEXTURED;
                    } else {
                        draw.program = BUILTIN_PROGRAM;
                    }
                    l.list.dirty.draws = true;
                }
            }
            // Nothing changes.
            _ => {}
        }
        w.run(&l.list, &facts);
        let mut fresh = CoverWalk {
            min_cover_area: 0,
            ..CoverWalk::default()
        };
        fresh.run(&l.list, &facts);
        assert_eq!(
            (&w.keep_draw, &w.keep_op, w.covers, w.noop_draws),
            (
                &fresh.keep_draw,
                &fresh.keep_op,
                fresh.covers,
                fresh.noop_draws
            ),
            "step {step}"
        );
        dropped += w.dropped_draws;
        noops += w.noop_draws;
        kept += l.list.draws.len() as u32 - w.dropped_draws;
        l.list.consumed();
    }
    assert!(dropped > 0 && kept > 0, "the scene both hides and shows");
    assert!(noops > 0, "and has no-op draws");
}

#[test]
fn a_texture_the_executor_reduces_covers_only_where_its_reduced_texels_are_opaque() {
    // 6000x4, opaque up to texel 3000 and transparent from 3001. A sprite shows texels [0, 3000)
    // at 1:1, its right edge inside the target. At full resolution every texel its pixels sample
    // is opaque; reduced by 2 (a 4096 limit) the last reduced texel it samples is texels 3000 and
    // 3001 averaged, half transparent.
    let (w, h) = (6000u32, 4u32);
    let mut px = vec![255u8; (4 * w * h) as usize];
    for y in 0..h {
        for x in 3001..w {
            px[(4 * (y * w + x) + 3) as usize] = 0;
        }
    }
    let mut facts = Facts::default();
    facts.opacity.insert(9, Opacity::from_rgba8(w, h, &px));
    let mut l = L::new(true);
    l.rect([40.0, 10.0, 50.0, 40.0], Blend::Mix, 0.5);
    let x = [1.0, 0.0, 0.0, 1.0, -2950.0, 0.0];
    l.grid(
        x,
        [0.0, 0.0, 3000.0, 50.0],
        1,
        1,
        [0.0, 0.0, 0.5, 1.0],
        9,
        Blend::Mix,
        1.0,
    );
    assert_eq!(
        walk(&l, &facts).0,
        [false, true],
        "no limit: the sprite hides the rect"
    );
    facts.max_side = 16384;
    assert_eq!(walk(&l, &facts).0, [false, true], "it fits a 16384 context");
    facts.max_side = 4096;
    assert_eq!(
        walk(&l, &facts).0,
        [true, true],
        "reduced by 2, the edge samples a half-transparent texel"
    );
    // Fully opaque, it covers however reduced.
    facts.opacity.insert(
        9,
        Opacity::from_rgba8(w, h, &vec![255u8; (4 * w * h) as usize]),
    );
    assert_eq!(walk(&l, &facts).0, [false, true]);
}

#[test]
fn geometry_placed_past_far_claims_no_cover_and_is_bounded_by_its_scissor() {
    let f = Facts::default();
    // A full-target rect, but drawn from local coordinates 300000 px out and translated back:
    // f32 error there exceeds the margin.
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 20.0, 20.0], Blend::Mix, 0.5);
    l.grid(
        [1.0, 0.0, 0.0, 1.0, -300_000.0, 0.0],
        [300_000.0, 0.0, 300_100.0, 50.0],
        1,
        1,
        [0.0, 0.0, 1.0, 1.0],
        WHITE_TEXTURE,
        Blend::Mix,
        1.0,
    );
    assert_eq!(walk(&l, &f).0, [true, true], "a far cover claims nothing");
    // A far draw under a near cover of half the target: its bounds are the whole target, so it
    // stays; under a cover of the whole target it goes.
    let mut l = L::new(true);
    l.grid(
        [1.0, 0.0, 0.0, 1.0, -300_000.0, 0.0],
        [300_010.0, 10.0, 300_020.0, 20.0],
        1,
        1,
        [0.0, 0.0, 1.0, 1.0],
        WHITE_TEXTURE,
        Blend::Mix,
        0.5,
    );
    l.rect([0.0, 0.0, 50.0, 50.0], Blend::Mix, 1.0);
    assert_eq!(walk(&l, &f).0, [true, true]);
    let mut l = L::new(true);
    l.grid(
        [1.0, 0.0, 0.0, 1.0, -300_000.0, 0.0],
        [300_010.0, 10.0, 300_020.0, 20.0],
        1,
        1,
        [0.0, 0.0, 1.0, 1.0],
        WHITE_TEXTURE,
        Blend::Mix,
        0.5,
    );
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    assert_eq!(walk(&l, &f).0, [false, true]);
}

/// A binding whose one uniform, `threshold`, is `v`.
fn threshold_binding(v: f32) -> Binding {
    Binding {
        program: 1,
        post_modulate: [1.0; 4],
        uniforms: vec![Uniform {
            name: "threshold".into(),
            value: UniformValue::Float(vec![v]),
        }],
        samplers: Vec::new(),
    }
}

/// A program whose final alpha is uniform 0 (`COLOR.a = threshold`), reading the screen or not.
fn threshold_facts(reads_screen: bool) -> Facts {
    let mut facts = Facts::default();
    facts.programs.push(ProgramFacts {
        reads_screen,
        vertex_stage: false,
        alpha: Some(AlphaUniform {
            uniform: 0,
            component: 0,
        }),
    });
    facts
}

#[test]
fn a_zero_alpha_draw_goes_under_every_blend_that_keeps_the_destination() {
    // Beside a translucent rect, a rect with modulate alpha 0 (colour kept), on
    // the root target and on a transparent one: mix, add and sub premultiply it to (0,0,0,0) and
    // keep the destination; premultiplied alpha adds its colour; mul blackens; disabled
    // overwrites.
    for opaque in [true, false] {
        for (blend, gone) in [
            (Blend::Mix, true),
            (Blend::Add, true),
            (Blend::Sub, true),
            (Blend::PremulAlpha, false),
            (Blend::Mul, false),
            (Blend::Disabled, false),
        ] {
            let mut l = L::new(opaque);
            l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
            // Beside the background, not over it (disabled would cover it).
            let z = l.rect([40.0, 0.0, 100.0, 50.0], blend, 0.0);
            l.list.items[z].modulate = [0.8, 0.4, 0.2, 0.0];
            let (k, _) = walk(&l, &Facts::default());
            assert_eq!(k, [true, !gone], "{blend:?} opaque {opaque}");
            // The same with every vertex alpha 0 and an opaque modulate.
            l.list.items[z].modulate = [0.8, 0.4, 0.2, 1.0];
            l.list.vertices[4..8]
                .iter_mut()
                .for_each(|v| v.color[3] = 0.0);
            assert_eq!(
                walk(&l, &Facts::default()).0,
                [true, !gone],
                "{blend:?} vertex alpha"
            );
            // A draw into the back buffer (a transparent target) follows the same rule.
            l.list.draws[z].flags |= DRAW_TO_BACK_BUFFER;
            let c = l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
            l.list.draws[c].flags |= DRAW_GROUP_COMPOSITE;
            assert_eq!(
                walk(&l, &Facts::default()).0[z],
                !gone,
                "{blend:?} back buffer"
            );
        }
    }
    // Premultiplied alpha goes with nothing to add: a zero colour too.
    let mut l = L::new(false);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    let z = l.rect([0.0, 0.0, 100.0, 50.0], Blend::PremulAlpha, 0.0);
    l.list.items[z].modulate = [0.0; 4];
    assert_eq!(walk(&l, &Facts::default()).0, [true, false]);
    l.list.items[z].modulate = [1.0, 1.0, 1.0, 0.0];
    l.list.vertices[4..8]
        .iter_mut()
        .for_each(|v| v.color = [0.0; 4]);
    assert_eq!(walk(&l, &Facts::default()).0, [true, false]);
    // One vertex with alpha left, or a second row with a modulate, keeps it.
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    let z = l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    l.list.vertices[4..8]
        .iter_mut()
        .for_each(|v| v.color[3] = 0.0);
    l.list.vertices[7].color[3] = 0.01;
    assert_eq!(walk(&l, &Facts::default()).0, [true, true]);
    l.list.items[z].modulate[3] = 0.0;
    l.list.items.push(Item {
        modulate: [1.0; 4],
        ..l.list.items[z]
    });
    l.list.vertices[7].item = l.list.items.len() as u32 - 1;
    assert_eq!(walk(&l, &Facts::default()).0, [true, true]);
}

#[test]
fn the_oracle_sees_a_premultiplied_zero_alpha_draw_paint() {
    // Premultiplied alpha with alpha 0 still adds its colour: dropping it changes pixels.
    let mut l = L::new(true);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    let z = l.rect([0.0, 0.0, 100.0, 50.0], Blend::PremulAlpha, 0.0);
    l.list.items[z].modulate = [0.5, 0.5, 0.5, 0.0];
    let mut culled = l.list.clone();
    culled.draws.remove(z);
    let f = Facts::default();
    assert!(provenance(&l.list, &f).mismatches(&provenance(&culled, &f)) > 0);
    // Mix does not.
    l.list.draws[z].blend = Blend::Mix as u32;
    assert_eq!(
        provenance(&l.list, &f).mismatches(&provenance(&culled, &f)),
        0
    );
}

#[test]
fn a_zero_alpha_draw_is_never_a_cover() {
    // A full-target rect at modulate alpha 0 over a translucent rect: gone, and hides nothing.
    let mut l = L::new(false);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 0.0);
    let mut w = CoverWalk {
        min_cover_area: 0,
        ..CoverWalk::default()
    };
    w.run(&l.list, &Facts::default());
    assert_eq!((w.covers, w.noop_draws), (0, 1));
    assert_eq!(walk(&l, &Facts::default()).0, [true, false]);
    // With no-ops kept the walk leaves everything.
    let mut w = CoverWalk {
        min_cover_area: 0,
        drop_noops: false,
        ..CoverWalk::default()
    };
    assert!(!w.run(&l.list, &Facts::default()));
}

#[test]
fn a_uniform_alpha_program_goes_at_zero_and_comes_back_with_its_uniform() {
    let facts = threshold_facts(false);
    let build = |v: f32, blend: Blend| {
        let mut l = L::new(true);
        l.list.bindings.push(threshold_binding(v));
        l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.5);
        let p = l.rect([0.0, 0.0, 100.0, 50.0], blend, 1.0);
        l.list.draws[p].program = 1;
        l.list.draws[p].flags &= !DRAW_UNTEXTURED;
        l
    };
    assert_eq!(walk(&build(0.0, Blend::Mix), &facts).0, [true, false]);
    assert_eq!(walk(&build(0.01, Blend::Mix), &facts).0, [true, true]);
    assert_eq!(walk(&build(-0.0, Blend::Add), &facts).0, [true, false]);
    assert_eq!(walk(&build(0.0, Blend::Sub), &facts).0, [true, false]);
    // A program's colour is not premultiplied under premultiplied alpha, and mul and disabled
    // are never no-ops.
    for blend in [Blend::PremulAlpha, Blend::Mul, Blend::Disabled] {
        assert_eq!(
            walk(&build(0.0, blend), &facts).0,
            [true, true],
            "{blend:?}"
        );
    }
    // Without the fact (an unrecognised shader) it stays; a zero post-modulate alpha (the canvas
    // modulate) makes any program a no-op.
    let mut unknown = Facts::default();
    unknown.programs.push(ProgramFacts {
        alpha: None,
        ..facts.programs[0]
    });
    assert_eq!(walk(&build(0.0, Blend::Mix), &unknown).0, [true, true]);
    let mut l = build(0.7, Blend::Mix);
    l.list.bindings[0].post_modulate[3] = 0.0;
    assert_eq!(walk(&l, &unknown).0, [true, false]);
    // A uniform the program reads is a float: an integer uniform proves nothing.
    let mut l = build(0.0, Blend::Mix);
    l.list.bindings[0].uniforms[0].value = UniformValue::Int(vec![0]);
    assert_eq!(walk(&l, &facts).0, [true, true]);

    // Across runs: the incremental walk follows the binding (the applier marks it dirty).
    let mut l = build(0.0, Blend::Mix);
    let mut w = CoverWalk {
        min_cover_area: 0,
        ..CoverWalk::default()
    };
    assert!(w.run(&l.list, &facts));
    assert_eq!(w.keep_draw, [true, false]);
    l.list.consumed();
    assert!(w.run(&l.list, &facts) && w.reused, "unchanged: replayed");
    l.list.consumed();
    l.list.set_binding(0, threshold_binding(0.5));
    assert!(!w.run(&l.list, &facts), "the uniform rose: drawn again");
    assert!(!w.reused);
    assert_eq!(w.keep_draw, [true, true]);
    l.list.consumed();
    l.list.set_binding(0, threshold_binding(0.0));
    assert!(w.run(&l.list, &facts));
    assert_eq!(w.keep_draw, [true, false]);
}

#[test]
fn a_zero_alpha_screen_reader_takes_its_copy_and_mips_with_it() {
    let facts = threshold_facts(true);
    let build = |v: f32| {
        let mut l = L::new(true);
        l.list.bindings.push(threshold_binding(v));
        l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 0.7);
        let r = l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
        l.list.draws[r].program = 1;
        l.list.draws[r].flags &= !DRAW_UNTEXTURED;
        l.op(r, ScreenOpKind::Copy, [0, 0, 100, 50], true);
        l.rect([20.0, 20.0, 40.0, 40.0], Blend::Mix, 0.5);
        l
    };
    let (k, o) = walk(&build(0.0), &facts);
    assert_eq!((k, o), (vec![true, false, true], vec![false]));
    let (k, o) = walk(&build(0.3), &facts);
    assert_eq!((k, o), (vec![true, true, true], vec![true]));
    // A second reader of the same copy keeps it.
    let mut l = build(0.0);
    l.list.bindings.push(threshold_binding(1.0));
    let r2 = l.rect([50.0, 20.0, 60.0, 30.0], Blend::Mix, 1.0);
    l.list.draws[r2].program = 2;
    l.list.draws[r2].flags &= !DRAW_UNTEXTURED;
    let mut facts2 = threshold_facts(true);
    facts2.programs.push(facts2.programs[0]);
    let (k, o) = walk(&l, &facts2);
    assert_eq!((k, o), (vec![true, false, true, true], vec![true]));
}

#[test]
fn a_zero_alpha_group_composite_takes_its_group_with_it() {
    // A clip group (copy, a draw into the back buffer, its composite) whose owner fades to 0.
    let build = |alpha: f32| {
        let mut l = L::new(true);
        l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 0.6);
        let g = l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 1.0);
        l.list.draws[g].flags |= DRAW_TO_BACK_BUFFER;
        l.op(g, ScreenOpKind::Copy, [10, 10, 20, 20], false);
        let c = l.rect([10.0, 10.0, 30.0, 30.0], Blend::PremulAlpha, alpha);
        l.list.draws[c].flags |= DRAW_GROUP_CLIP;
        l
    };
    let (k, o) = walk(&build(0.0), &Facts::default());
    assert_eq!((k, o), (vec![true, false, false], vec![false]));
    let (k, o) = walk(&build(0.5), &Facts::default());
    assert_eq!((k, o), (vec![true, true, true], vec![true]));
}

#[test]
fn the_incremental_no_op_set_follows_first_vertices_rows_and_indices() {
    // Three translucent rects; each change marked as an applier marks it, and after each the
    // incremental walk keeps what a fresh walk keeps.
    let mut l = L::new(true);
    l.rect([0.0, 0.0, 30.0, 30.0], Blend::Mix, 0.5);
    let a = l.rect([10.0, 10.0, 40.0, 40.0], Blend::Mix, 0.5);
    let b = l.rect([50.0, 10.0, 80.0, 40.0], Blend::Mix, 0.5);
    let f = Facts::default();
    let mut w = CoverWalk {
        min_cover_area: 0,
        ..CoverWalk::default()
    };
    let mut check = |l: &mut L, want: [bool; 3], what: &str| {
        w.run(&l.list, &f);
        let mut fresh = CoverWalk {
            min_cover_area: 0,
            ..CoverWalk::default()
        };
        fresh.run(&l.list, &f);
        assert_eq!(w.keep_draw, fresh.keep_draw, "{what}: unlike a fresh walk");
        assert_eq!(w.keep_draw, want, "{what}");
        l.list.consumed();
    };
    check(&mut l, [true, true, true], "start");
    let alpha = |l: &mut L, d: usize, v: f32| {
        let first = 4 * d as u32;
        for x in first..first + 4 {
            l.list.vertices[x as usize].color[3] = v;
        }
        l.list.dirty.vertices.add(first, first + 4);
    };
    alpha(&mut l, a, 0.0);
    check(&mut l, [true, false, true], "a's vertices at 0");
    alpha(&mut l, a, 1.0);
    check(&mut l, [true, true, true], "a shows again");
    // Its first vertex must be watched again now that it shows.
    alpha(&mut l, a, 0.0);
    check(&mut l, [true, false, true], "a at 0 again");
    // b's indices now name a's (zero-alpha) vertices: only an index changed.
    let (fa, fb) = (
        l.list.draws[a].first_index as usize,
        l.list.draws[b].first_index as usize,
    );
    let ia: Vec<u32> = l.list.indices[fa..fa + 6].to_vec();
    l.list.indices[fb..fb + 6].copy_from_slice(&ia);
    l.list.dirty.indices.add(fb as u32, fb as u32 + 6);
    check(&mut l, [true, false, false], "b reads a's vertices");
    // A row's modulate goes to 0, then a vertex moves to that row.
    alpha(&mut l, a, 1.0);
    l.list.items[0].modulate[3] = 0.0;
    l.list.dirty.items.add(0, 1);
    check(&mut l, [false, true, true], "row 0 at 0");
    // Row 2 (b's own, which b no longer reads) goes to 0; then a's vertices move to it, only
    // the vertices marked.
    l.list.items[2].modulate[3] = 0.0;
    l.list.dirty.items.add(2, 3);
    check(&mut l, [false, true, true], "an unread row at 0");
    for x in 4..8 {
        l.list.vertices[x].item = 2;
    }
    l.list.dirty.vertices.add(4, 8);
    check(
        &mut l,
        [false, false, false],
        "a's vertices on the zero row",
    );
    // Rect 0's vertices move to row 1, which then goes to 0.
    for x in 0..4 {
        l.list.vertices[x].item = 1;
    }
    l.list.dirty.vertices.add(0, 4);
    l.list.items[1].modulate[3] = 0.0;
    l.list.dirty.items.add(1, 2);
    check(&mut l, [false, false, false], "every rect on row 1, at 0");
}

#[test]
fn a_reorder_or_a_state_change_at_an_equal_count_reads_every_no_op_again() {
    // An opaque background, a rect at modulate alpha 0, then a full-target overlay whose alpha is
    // its uniform, at 0.5. Swapping the last two must not leave the overlay with the zero rect's
    // answer (it would vanish while visible).
    let facts = threshold_facts(false);
    let mut l = L::new(true);
    l.list.bindings.push(threshold_binding(0.5));
    l.rect([0.0, 0.0, 100.0, 50.0], Blend::Disabled, 1.0);
    l.rect([10.0, 10.0, 30.0, 30.0], Blend::Mix, 0.0);
    let p = l.rect([0.0, 0.0, 100.0, 50.0], Blend::Mix, 1.0);
    l.list.draws[p].program = 1;
    l.list.draws[p].flags &= !DRAW_UNTEXTURED;
    let mut w = CoverWalk {
        min_cover_area: 0,
        ..CoverWalk::default()
    };
    let mut check = |l: &mut L, want: [bool; 3], what: &str| {
        w.run(&l.list, &facts);
        let mut fresh = CoverWalk {
            min_cover_area: 0,
            ..CoverWalk::default()
        };
        fresh.run(&l.list, &facts);
        assert_eq!(w.keep_draw, fresh.keep_draw, "{what}: unlike a fresh walk");
        assert_eq!(w.keep_draw, want, "{what}");
        l.list.consumed();
    };
    check(&mut l, [true, false, true], "the zero rect goes");
    l.list.draws.swap(1, 2);
    l.list.dirty.draws = true;
    check(&mut l, [true, true, false], "swapped: the overlay stays");
    l.list.draws.swap(1, 2);
    l.list.dirty.draws = true;
    check(&mut l, [true, false, true], "swapped back");
    // The zero rect turns mul (blackens on the root target): drawn.
    l.list.draws[1].blend = Blend::Mul as u32;
    l.list.dirty.draws = true;
    check(&mut l, [true, true, true], "mul at alpha 0 is drawn");
    // It takes the overlay's program (at 0.5): drawn.
    l.list.draws[1].blend = Blend::Mix as u32;
    l.list.draws[1].program = 1;
    l.list.draws[1].flags &= !DRAW_UNTEXTURED;
    l.list.dirty.draws = true;
    check(&mut l, [true, true, true], "a builtin no-op turned program");
}

/// Runs the tile half over `l` as it stands (every owner analysed, every hidden pixel worth a
/// test) and leaves its tables in the list; checks that the list paints with them what it paints
/// without (the oracle honours the depth test) and that a fresh, slack-free check stands behind
/// them.
fn tile(l: &mut L, facts: &Facts) -> tiles::TileWalk {
    let mut t = tiles_walk(1);
    tile_again(l, facts, &mut t);
    t
}

fn tile_again(l: &mut L, facts: &Facts, t: &mut tiles::TileWalk) {
    t.run(&l.list, facts);
    l.list.depth_tiles.clone_from(&t.tiles);
    l.list.depth_draws.clone_from(&t.draws);
    let mut plain = l.list.clone();
    plain.depth_tiles.clear();
    plain.depth_draws.clear();
    let (a, b) = (provenance(&plain, facts), provenance(&l.list, facts));
    if a.mismatches(&b) != 0 {
        let bad: Vec<(usize, usize)> = (0..a.rgb.len())
            .filter(|&i| a.rgb[i] != b.rgb[i] || a.alpha[i] != b.alpha[i])
            .map(|i| (i % a.width as usize, i / a.width as usize))
            .take(12)
            .collect();
        panic!(
            "the tiled list paints differently at {bad:?} ({:?} {:?})",
            t.tiles, t.draws
        );
    }
    let owners = t.owners.clone();
    assert!(
        tiles::TileWalk::default().verify(&l.list, &owners, facts),
        "unverified tables {:?} {:?}",
        t.tiles,
        t.draws
    );
}

/// A backdrop, then an atlas sprite (opaque but for a 2-texel frame) over part of it.
fn backdrop_and_framed_cover(opaque: bool) -> (L, Facts) {
    let mut l = L::sized(256, 128, opaque);
    l.rect([0.0, 0.0, 256.0, 128.0], Blend::Mix, 0.5);
    l.grid(
        ID,
        [32.0, 0.0, 160.0, 128.0],
        1,
        1,
        [0.0, 0.0, 1.0, 1.0],
        7,
        Blend::Mix,
        1.0,
    );
    let mut f = Facts::default();
    f.opacity.insert(7, atlas(None));
    (l, f)
}

#[test]
fn tiles_hide_the_part_of_a_draw_a_partly_opaque_cover_overwrites() {
    let (mut l, f) = backdrop_and_framed_cover(true);
    // The whole-draw walk keeps everything (the cover's frame is transparent).
    let (k, _) = walk(&l, &f);
    assert_eq!(k, [true, true]);
    let t = tile(&mut l, &f);
    // The frame is 4 px wide on screen and the target edges are boundary edges: the cells
    // [64, 128) x [32, 96) are the ones whose grown pixel centres are inside the opaque texels.
    assert_eq!(
        t.tiles,
        [crate::DepthTile {
            rect: [64, 32, 64, 64],
            level: 1
        }]
    );
    assert_eq!(t.draws, [crate::DepthDraw { draw: 0, level: 0 }]);
    assert_eq!(t.owners, [1]);
    assert_eq!(t.hidden_px, 64 * 64);
    assert_eq!(l.list.merged_draw_count(), 2);
    // The fill model takes the rejected fragments out of the backdrop.
    let fill = crate::fill::account(&l.list, &crate::fill::FillOptions::default());
    assert_eq!(fill.depth_rejected_px, 4096.0);
    assert_eq!(fill.depth_prepass_px, 4096.0);
}

#[test]
fn a_cover_drawn_before_a_draw_hides_nothing_of_it() {
    let mut l = L::sized(256, 128, true);
    l.grid(
        ID,
        [32.0, 0.0, 160.0, 128.0],
        1,
        1,
        [0.0, 0.0, 1.0, 1.0],
        7,
        Blend::Mix,
        1.0,
    );
    l.rect([0.0, 0.0, 256.0, 128.0], Blend::Mix, 0.5);
    let mut f = Facts::default();
    f.opacity.insert(7, atlas(None));
    let t = tile(&mut l, &f);
    assert!(t.tiles.is_empty() && t.draws.is_empty());
}

#[test]
fn a_copy_between_a_draw_and_its_cover_takes_its_region_out() {
    let (mut l, f) = backdrop_and_framed_cover(true);
    // A copy of [100, 40, 10x10] before the cover: it reads the backdrop there, and the window
    // ends at the draw it precedes (the cover itself here).
    l.op(1, ScreenOpKind::Copy, [100, 40, 10, 10], false);
    let t = tile(&mut l, &f);
    // Cell (3, 1) = [96, 128) x [32, 64) meets the copy (runs merge along rows first).
    let mut cells: Vec<[i32; 4]> = t.tiles.iter().map(|t| t.rect).collect();
    cells.sort_unstable();
    assert_eq!(cells, [[64, 32, 32, 32], [64, 64, 64, 32]]);
    assert_eq!(t.draws, [crate::DepthDraw { draw: 0, level: 0 }]);
    // A whole-target copy leaves nothing.
    l.list.screen_ops[0].region = [0, 0, 256, 128];
    l.list.depth_tiles.clear();
    l.list.depth_draws.clear();
    let t = tile(&mut l, &f);
    assert!(t.tiles.is_empty());
}

#[test]
fn only_draws_before_the_first_back_buffer_operation_are_tested() {
    let (mut l, f) = backdrop_and_framed_cover(true);
    // A second backdrop after a clear: past the window.
    let d = l.rect([0.0, 0.0, 256.0, 128.0], Blend::Mix, 0.5);
    l.op(d, ScreenOpKind::Clear, [0, 0, 0, 0], false);
    l.grid(
        ID,
        [32.0, 0.0, 160.0, 128.0],
        1,
        1,
        [0.0, 0.0, 1.0, 1.0],
        7,
        Blend::Mix,
        1.0,
    );
    let t = tile(&mut l, &f);
    // Draw 0 under both covers (its level 0; the cells' level is the last owner's, 2), and the
    // first cover under the second (level 1); the second backdrop is not listed.
    assert_eq!(
        t.draws,
        [
            crate::DepthDraw { draw: 0, level: 0 },
            crate::DepthDraw { draw: 1, level: 1 }
        ]
    );
    assert_eq!(t.owners, [1, 3]);
    assert!(t.tiles.iter().all(|t| t.level == 2));
}

#[test]
fn a_cover_is_tested_under_a_later_cover_at_its_own_level() {
    let (mut l, f) = backdrop_and_framed_cover(true);
    // A second framed sprite over the first, shifted by 32 px.
    l.grid(
        ID,
        [64.0, 0.0, 192.0, 128.0],
        1,
        1,
        [0.0, 0.0, 1.0, 1.0],
        7,
        Blend::Mix,
        1.0,
    );
    let t = tile(&mut l, &f);
    assert_eq!(
        t.draws,
        [
            crate::DepthDraw { draw: 0, level: 0 },
            crate::DepthDraw { draw: 1, level: 1 }
        ]
    );
    // [96, 160) is the second owner's (level 2), [64, 96) only the first's.
    let mut tiles: Vec<([i32; 4], u32)> = t.tiles.iter().map(|t| (t.rect, t.level)).collect();
    tiles.sort_unstable();
    assert_eq!(tiles, [([64, 32, 32, 64], 1), ([96, 32, 64, 64], 2)]);
    // Different levels never share a call.
    assert_eq!(l.list.merged_draw_count(), 3);
}

#[test]
fn on_an_opaque_target_a_draw_that_writes_alpha_is_never_tested() {
    let (mut l, f) = backdrop_and_framed_cover(true);
    l.list.draws[0].blend = Blend::Disabled as u32;
    assert!(tile(&mut l, &f).draws.is_empty());
    // A transparent target: every owner writes alpha 1 too.
    let (mut l, f) = backdrop_and_framed_cover(false);
    l.list.draws[0].blend = Blend::Disabled as u32;
    assert_eq!(tile(&mut l, &f).draws.len(), 1);
}

#[test]
fn a_translucent_texel_inside_a_cell_keeps_that_cell() {
    let cells =
        |t: &tiles::TileWalk| -> i32 { t.tiles.iter().map(|t| t.rect[2] * t.rect[3] / 1024).sum() };
    for sampler in [0, Sampler::LINEAR] {
        // Atlas texel (40, 40) translucent: screen [112, 114) x [80, 82), in cell [96, 128) x
        // [64, 96) only, even grown by the slack and the linear footprint.
        let (mut l, mut f) = backdrop_and_framed_cover(true);
        l.list.draws[1].sampler = sampler;
        f.opacity.insert(7, atlas(Some((40, 40))));
        let t = tile(&mut l, &f);
        assert_eq!(cells(&t), 3, "{sampler} {:?}", t.tiles);
        // Texel (32, 32) sits at the corner of four cells, which the slack reaches from each.
        let (mut l, mut f) = backdrop_and_framed_cover(true);
        l.list.draws[1].sampler = sampler;
        f.opacity.insert(7, atlas(Some((32, 32))));
        assert_eq!(cells(&tile(&mut l, &f)), 0);
    }
}

#[test]
fn a_mesh_cover_claims_cells_across_its_interior_edges() {
    // A 4x2 grid with wobbly interior vertices over the whole target, white: every cell inside
    // the target edges is claimed, whatever interior edge crosses it.
    let mut l = L::sized(256, 128, true);
    l.rect([0.0, 0.0, 256.0, 128.0], Blend::Mix, 0.5);
    let d = l.grid(
        ID,
        [-8.0, -8.0, 264.0, 136.0],
        4,
        2,
        [0.0, 0.0, 1.0, 1.0],
        WHITE_TEXTURE,
        Blend::Mix,
        1.0,
    );
    for (k, v) in l.list.vertices.iter_mut().enumerate().skip(4) {
        let inner = (k - 4) % 5 != 0 && (k - 4) % 5 != 4 && (5..10).contains(&(k - 4));
        if inner {
            v.pos[0] += 3.25;
            v.pos[1] -= 1.5;
        }
    }
    // The whole-draw walk drops the backdrop outright (the mesh covers the target)...
    let (k, _) = walk(&l, &Facts::default());
    assert_eq!(k, [false, true]);
    // ...and on the list it keeps there is nothing left to test; without the walk the tiles
    // cover every cell.
    let t = tile(&mut l, &Facts::default());
    assert_eq!(t.owners, [d as u32]);
    let cells: i32 = t.tiles.iter().map(|t| t.rect[2] * t.rect[3]).sum();
    assert_eq!(cells, 256 * 128);
}

#[test]
fn an_owner_drifting_less_than_the_slack_keeps_its_tiles_without_a_new_classification() {
    // Every step checks the tiled list against the plain one (`tile_again`).
    let (mut l, f) = backdrop_and_framed_cover(true);
    let mut t = tiles_walk(1);
    tile_again(&mut l, &f, &mut t);
    assert_eq!(t.classified, 1);
    let first = t.tiles.clone();
    // A translation of the row within the slack...
    for step in 1..=3 {
        l.list.items[1].xform[4] = 0.3 * step as f32;
        l.list.items[1].xform[5] = -0.25 * step as f32;
        tile_again(&mut l, &f, &mut t);
        assert_eq!(t.classified, 0, "step {step}");
        assert_eq!(t.tiles, first);
    }
    // ...a deformation within it (a scale moving no vertex a pixel from where it was classified,
    // vertices wobbling)...
    l.list.items[1].xform[4] = 0.0;
    l.list.items[1].xform[5] = 0.0;
    l.list.items[1].xform[0] = 1.001;
    tile_again(&mut l, &f, &mut t);
    assert_eq!(t.classified, 0);
    for v in &mut l.list.vertices[4..8] {
        v.pos[0] += 0.4;
        v.pos[1] -= 0.4;
    }
    tile_again(&mut l, &f, &mut t);
    assert_eq!(t.classified, 0);
    // ...hold; past it, classified again where it now stands.
    for _ in 0..40 {
        tile_again(&mut l, &f, &mut t);
    }
    l.list.items[1].xform[4] = 1.5;
    tile_again(&mut l, &f, &mut t);
    assert_eq!(t.classified, 1);
}

#[test]
fn an_owner_classified_again_soon_gets_twice_the_slack() {
    let (mut l, f) = backdrop_and_framed_cover(true);
    let mut t = tiles_walk(1);
    tile_again(&mut l, &f, &mut t);
    // Moved past 1 px right after its classification: classified again, with 2 px of slack...
    l.list.items[1].xform[4] = 1.25;
    tile_again(&mut l, &f, &mut t);
    assert_eq!(t.classified, 1);
    tile_again(&mut l, &f, &mut t);
    // ...so a further 1.5 px holds.
    l.list.items[1].xform[4] = 2.75;
    tile_again(&mut l, &f, &mut t);
    assert_eq!(t.classified, 0);
    assert!(!t.tiles.is_empty());
}

#[test]
fn an_animated_owner_claims_nothing_until_it_holds_still() {
    let (mut l, f) = backdrop_and_framed_cover(true);
    let mut t = tiles_walk(1);
    tile_again(&mut l, &f, &mut t);
    for _ in 0..40 {
        tile_again(&mut l, &f, &mut t);
    }
    // Moving past the slack in consecutive runs: the first move classifies, the rest back off
    // and claim nothing...
    for step in 1..=5 {
        l.list.vertices[4].pos[0] += 10.0;
        tile_again(&mut l, &f, &mut t);
        assert_eq!(t.classified, u32::from(step == 1), "step {step}");
        if step > 1 {
            assert!(t.tiles.is_empty(), "step {step}");
        }
    }
    // ...until it holds still for a few runs.
    for _ in 1..tiles::STILL {
        tile_again(&mut l, &f, &mut t);
        assert_eq!(t.classified, 0);
        assert!(t.tiles.is_empty());
    }
    tile_again(&mut l, &f, &mut t);
    assert_eq!(t.classified, 1);
    assert!(!t.tiles.is_empty());
}

#[test]
fn the_oracle_sees_a_tile_the_cover_does_not_overwrite() {
    let (mut l, f) = backdrop_and_framed_cover(true);
    l.list.depth_tiles = vec![crate::DepthTile {
        rect: [32, 32, 32, 32],
        level: 1,
    }];
    l.list.depth_draws = vec![crate::DepthDraw { draw: 0, level: 0 }];
    let mut plain = l.list.clone();
    plain.depth_tiles.clear();
    assert!(provenance(&l.list, &f).mismatches(&provenance(&plain, &f)) > 0);
    assert!(!tiles::TileWalk::default().verify(&l.list, &[1], &f));
}

#[test]
fn a_small_hidden_area_is_not_worth_a_test() {
    let (mut l, f) = backdrop_and_framed_cover(true);
    let mut t = tiles_walk(64 * 64 + 1);
    t.run(&l.list, &f);
    assert!(t.tiles.is_empty() && t.draws.is_empty() && t.owners.is_empty());
    l.list.depth_tiles.clear();
}

fn tiles_walk(min_hidden_px: u32) -> tiles::TileWalk {
    let mut t = tiles::TileWalk::default();
    t.min_cover_area = 0;
    t.min_hidden_px = min_hidden_px;
    t
}

#[test]
fn a_check_with_no_slack_never_carries_a_verdict_across_an_edge_between_cells() {
    // A white L-shaped cover (one draw, one row): [0, 128) x [0, 128) and [0, 256) x [128, 192).
    // Its edge x = 128 lies on a cell boundary, and with no slack the grown pixel-centre
    // rectangles of cells [96, 128) and [128, 160) (rows [64, 96)) do not meet, so the edge passes
    // between them: the first's inside verdict must not reach the second, outside the L.
    let mut l = L::sized(256, 192, true);
    l.rect([0.0, 0.0, 256.0, 192.0], Blend::Mix, 0.5);
    l.rect([0.0, 0.0, 128.0, 128.0], Blend::Mix, 1.0);
    l.rect([0.0, 128.0, 256.0, 192.0], Blend::Mix, 1.0);
    let second = l.list.draws.pop().expect("three draws");
    l.list.draws[1].index_count += second.index_count;
    for v in &mut l.list.vertices[8..] {
        v.item = 1;
    }
    let f = Facts::default();
    l.list.depth_draws = vec![crate::DepthDraw { draw: 0, level: 0 }];
    l.list.depth_tiles = vec![crate::DepthTile {
        rect: [96, 64, 32, 32],
        level: 1,
    }];
    assert!(tiles::TileWalk::default().verify(&l.list, &[1], &f));
    l.list.depth_tiles[0].rect = [128, 64, 32, 32];
    assert!(!tiles::TileWalk::default().verify(&l.list, &[1], &f));
    // The walk's own tiles (its slack keeps neighbours connected) stay inside the L.
    l.list.depth_tiles.clear();
    l.list.depth_draws.clear();
    let t = tile(&mut l, &f);
    assert!(!t.tiles.is_empty());
    assert!(
        t.tiles
            .iter()
            .all(|t| t.rect[0] + t.rect[2] <= 128 || t.rect[1] >= 128),
        "{:?}",
        t.tiles
    );
}

#[test]
fn a_seam_between_duplicate_vertices_never_keeps_its_tiles() {
    // Two triangles sharing their diagonal through DISTINCT vertex records at bit-identical
    // positions: the boundary cancels the diagonal by position, so the cells across it are
    // claimed. Separating the copies by less than the slack opens a seam there (pixel centre
    // (64.5, 64.5) lies in neither triangle): the memo must not hold.
    let mut l = L::sized(256, 128, true);
    l.rect([0.0, 0.0, 256.0, 128.0], Blend::Mix, 0.5);
    let item = l.list.items.len() as u32;
    l.list.items.push(Item {
        xform: ID,
        modulate: [0.2, 0.6, 0.3, 1.0],
        ..Item::default()
    });
    let base = l.list.vertices.len() as u32;
    for p in [
        [-8.0, -8.0],
        [136.0, -8.0],
        [136.0, 136.0],
        [-8.0, -8.0],
        [136.0, 136.0],
        [-8.0, 136.0],
    ] {
        l.list.vertices.push(Vertex {
            pos: p,
            uv: [0.0, 0.0],
            color: [1.0; 4],
            item,
        });
    }
    let first = l.list.indices.len() as u32;
    l.list.indices.extend((0..6).map(|k| base + k));
    l.list.draws.push(Draw {
        first_index: first,
        index_count: 6,
        texture: WHITE_TEXTURE,
        blend: Blend::Mix as u32,
        flags: DRAW_UNTEXTURED,
        ..Draw::default()
    });
    let f = Facts::default();
    let mut t = tiles_walk(1);
    tile_again(&mut l, &f, &mut t);
    assert!(t.tiles.iter().any(|r| r.rect[0] <= 64 && r.rect[1] <= 64), "{:?}", t.tiles);
    for (k, v) in l.list.vertices[base as usize..].iter_mut().enumerate() {
        let d = if k < 3 { [0.75, -0.75] } else { [-0.75, 0.75] };
        v.pos = [v.pos[0] + d[0], v.pos[1] + d[1]];
    }
    // `tile_again` checks the tiled list against the plain one and `verify` on run 2's tables.
    tile_again(&mut l, &f, &mut t);
    assert_eq!(t.classified, 1);
}

#[test]
fn binding_range_proofs_use_the_same_blend_rules_and_recheck_without_dirt() {
    struct Ranges(bool);
    impl CoverFacts for Ranges {
        fn opacity(&self, _: u32) -> Option<&Opacity> {
            None
        }
        fn program(&self, _: u32) -> ProgramFacts {
            ProgramFacts {
                reads_screen: false,
                vertex_stage: false,
                alpha: None,
            }
        }
        fn alpha_zero(&self, _: u32) -> bool {
            self.0
        }
    }
    for opaque in [false, true] {
        for blend in [
            Blend::Mix,
            Blend::Add,
            Blend::Sub,
            Blend::PremulAlpha,
            Blend::Mul,
            Blend::Disabled,
        ] {
            let mut l = L::new(opaque);
            l.list.bindings.push(threshold_binding(0.5));
            let p = l.rect([0.0, 0.0, 100.0, 50.0], blend, 1.0);
            l.list.draws[p].program = 1;
            let mut w = CoverWalk::default();
            let drops = matches!(blend, Blend::Mix | Blend::Add | Blend::Sub);
            assert_eq!(
                noop(&l.list, p, &Ranges(true)),
                drops,
                "{blend:?} opaque {opaque}"
            );
            w.run(&l.list, &Ranges(true));
            assert_eq!(w.keep_draw, [!drops]);
            let mut culled = l.list.clone();
            w.compact(
                &l.list.draws,
                &l.list.screen_ops,
                &l.list.instanced,
                &mut culled.draws,
                &mut culled.screen_ops,
                &mut culled.instanced,
            );
            assert_eq!(
                provenance(&l.list, &Ranges(true)).mismatches(&provenance(&culled, &Ranges(true))),
                0,
                "{blend:?} opaque {opaque}"
            );
            if drops {
                assert!(
                    provenance(&l.list, &Ranges(false))
                        .mismatches(&provenance(&culled, &Ranges(false)))
                        > 0
                );
            }
            l.list.consumed();
            // Format-only changes need not change the binding or any draw-list dirty range.
            w.run(&l.list, &Ranges(false));
            assert_eq!(w.keep_draw, [true]);
            l.list.consumed();
            w.run(&l.list, &Ranges(true));
            assert_eq!(w.keep_draw, [!drops]);
        }
    }
}
