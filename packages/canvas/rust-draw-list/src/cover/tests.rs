use super::oracle::provenance;
use super::*;
use crate::{Binding, Item, Sampler, Target, Vertex, DRAW_SCREEN_OPS};
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
        L {
            list: DrawList::new(Target {
                width: 100,
                height: 50,
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
    facts.programs.push(ProgramFacts {
        reads_screen: true,
        vertex_stage: false,
    });
    let mut l = L::new(true);
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
    let (mut dropped, mut kept) = (0, 0);
    for step in 0..600 {
        match rnd(7) {
            // A row moves by up to a pixel, or jumps.
            0 => {
                let r = rnd(n_items);
                let d = if rnd(4) == 0 { 20.0 } else { 0.25 };
                l.list.items[r as usize].xform[4] += d * (rnd(3) as f32 - 1.0);
                l.list.items[r as usize].xform[5] += d * (rnd(3) as f32 - 1.0);
                l.list.dirty.items.add(r, r + 1);
            }
            // A modulate alpha flips between opaque and not.
            1 => {
                let r = rnd(n_items) as usize;
                let m = &mut l.list.items[r].modulate[3];
                *m = if *m >= 1.0 { 0.6 } else { 1.0 };
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
            // A vertex alpha drops and comes back.
            5 => {
                let v = rnd(n_verts) as usize;
                let a = &mut l.list.vertices[v].color[3];
                *a = if *a >= 1.0 { 0.5 } else { 1.0 };
                l.list.dirty.vertices.add(v as u32, v as u32 + 1);
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
            (&w.keep_draw, &w.keep_op, w.covers),
            (&fresh.keep_draw, &fresh.keep_op, fresh.covers),
            "step {step}"
        );
        dropped += w.dropped_draws;
        kept += l.list.draws.len() as u32 - w.dropped_draws;
        l.list.consumed();
    }
    assert!(dropped > 0 && kept > 0, "the scene both hides and shows");
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
