use gsw_canvas_draw_list::cover::{
    groups::{GroupRange, GroupWalk},
    CoverFacts, ProgramFacts,
};
use gsw_canvas_draw_list::{opacity::Opacity, *};
struct Facts(Option<Opacity>);
impl CoverFacts for Facts {
    fn opacity(&self, id: u32) -> Option<&Opacity> {
        if id == 1 {
            self.0.as_ref()
        } else {
            None
        }
    }
    fn program(&self, _: u32) -> ProgramFacts {
        ProgramFacts::UNKNOWN
    }
}
fn facts(live: impl Fn(u32, u32) -> bool) -> Facts {
    let mut rgba = vec![0; 128 * 128 * 4];
    for y in 0..128 {
        for x in 0..128 {
            rgba[((y * 128 + x) * 4 + 3) as usize] = u8::from(live(x, y));
        }
    }
    Facts(Some(Opacity::from_rgba8(128, 128, &rgba)))
}
fn fixture() -> (DrawList, Vec<GroupRange>) {
    let mut l = DrawList::default();
    l.target.width = 128;
    l.target.height = 128;
    l.items.push(Item {
        xform: [1., 0., 0., 1., 0., 0.],
        modulate: [1.; 4],
        ..Item::default()
    });
    for pos in [[0., 0.], [128., 0.], [128., 128.], [0., 128.]] {
        l.vertices.push(Vertex {
            pos,
            uv: [pos[0] / 128., pos[1] / 128.],
            color: [1.; 4],
            ..Vertex::default()
        });
    }
    l.indices.extend([0, 1, 2, 0, 2, 3]);
    let draw = Draw {
        texture: 1,
        sampler: Sampler::LINEAR,
        index_count: 6,
        ..Draw::default()
    };
    l.draws.push(Draw {
        flags: DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS,
        ..draw
    });
    l.draws.push(Draw {
        flags: DRAW_GROUP_CLIP,
        ..draw
    });
    l.screen_ops.push(ScreenOp {
        before: 0,
        kind: ScreenOpKind::Copy,
        region: [0, 0, 128, 128],
        mipmaps: false,
        sample_mips: false,
    });
    (
        l,
        vec![GroupRange {
            first: 0,
            composite: 1..2,
        }],
    )
}
fn run(l: &mut DrawList, g: &[GroupRange], f: &Facts) -> GroupWalk {
    let mut w = GroupWalk::default();
    w.prepare(l, g, f, true);
    w.apply(l);
    w
}
fn dead(l: &DrawList, x: i32, y: i32) -> bool {
    l.group_cells
        .iter()
        .flat_map(|g| &g.rects)
        .any(|r| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3])
}
#[test]
fn holes_dead_and_cells_touching_positive_footprints_live() {
    let (mut l, g) = fixture();
    run(&mut l, &g, &facts(|x, y| x < 8 && y < 8));
    assert!(!l.group_cells.is_empty());
    assert_eq!(l.group_cells[0].draws, 0..1);
    for y in 0..8 {
        for x in 0..8 {
            assert_eq!(dead(&l, x * 16 + 8, y * 16 + 8), x != 0 || y != 0);
        }
    }
    for (x, y) in [(16, 8), (15, 8), (127, 8), (0, 127), (64, 64)] {
        let (mut l, g) = fixture();
        run(&mut l, &g, &facts(|a, b| a == x && b == y));
        // The cell immediately left of a positive texel still samples it at its bilinear edge.
        assert!(!dead(&l, x.saturating_sub(1) as i32, y as i32));
        assert!(!dead(&l, x as i32, y as i32));
    }
}
#[test]
fn clamp_and_repeat_borders_fail_conservatively() {
    for sampler in [Sampler::CLAMP, Sampler::REPEAT, Sampler::MIRROR] {
        let (mut l, g) = fixture();
        l.draws[1].sampler = sampler | Sampler::LINEAR;
        run(&mut l, &g, &facts(|x, _| x == 127));
        assert!(!dead(&l, 127, 64));
        if sampler != Sampler::CLAMP {
            assert!(!dead(&l, 0, 64));
        }
        assert!(dead(&l, 64, 64));
    }
    let (mut l, g) = fixture();
    for v in &mut l.vertices {
        v.uv[0] -= 2.;
    }
    run(&mut l, &g, &facts(|x, _| x == 0));
    assert!(
        l.group_cells.is_empty(),
        "clamp outside the image must sample its edge"
    );
}
#[test]
fn outside_triangles_dead_even_over_opaque_texture() {
    let (mut l, g) = fixture();
    l.draws[1].index_count = 3;
    run(&mut l, &g, &facts(|_, _| true));
    assert!(dead(&l, 8, 120));
    assert!(!dead(&l, 120, 8));
}
#[test]
fn shared_gates_and_unknown_formats_produce_no_cells() {
    for gate in 0..14 {
        let (mut l, mut g) = fixture();
        let mut f = facts(|_, _| false);
        match gate {
            0 => l.draws[1].blend = Blend::Mul as u32,
            1 => l.screen_ops[0].mipmaps = true,
            2 => {
                l.draws.push(Draw {
                    program: 1,
                    ..l.draws[1]
                });
            }
            3 => {
                l.draws.extend([l.draws[0], l.draws[1]]);
                l.screen_ops.push(ScreenOp {
                    before: 2,
                    region: [0, 0, 32, 32],
                    ..l.screen_ops[0]
                });
                g.push(GroupRange {
                    first: 2,
                    composite: 3..4,
                });
            }
            4 => l.draws[1].texture = 999, // Unknown, compressed, half or surface: no RGBA8 opacity.
            5 => l.draws[1].flags = DRAW_GROUP_COMPOSITE,
            6 => l.draws[1].program = 1,
            7 => l.draws[1].flags |= DRAW_INSTANCED,
            8 => {
                l.screen_ops.push(ScreenOp {
                    before: 1,
                    kind: ScreenOpKind::Mipmaps,
                    ..l.screen_ops[0]
                });
            }
            9 => f.0 = None,
            10 => l.items[0].flags |= ITEM_UNTEXTURED,
            11 => {
                l.vertices[1].pos = l.vertices[0].pos;
            }
            12 => l.draws[1].flags |= DRAW_MSDF,
            13 => l.draws[1].flags |= DRAW_UNTEXTURED,
            _ => unreachable!(),
        }
        run(&mut l, &g, &f);
        assert!(l.group_cells.is_empty(), "gate {gate}");
    }
}

#[test]
fn memoized_cells_follow_later_screen_reader_changes() {
    let (mut list, groups) = fixture();
    let facts = facts(|_, _| false);
    let mut walk = run(&mut list, &groups, &facts);
    assert!(!list.group_cells.is_empty());
    let expected = list.group_cells.clone();

    // Warm the memo without changing a single owner input. A later program reads the cached
    // back buffer without a copy of its own: those previously dead pixels become observable.
    walk.restore(&mut list);
    walk.prepare(&list, &groups, &facts, true);
    walk.apply(&mut list);
    assert_eq!(list.group_cells, expected);
    walk.restore(&mut list);
    list.draws.push(Draw {
        program: 1,
        ..list.draws[1]
    });
    walk.prepare(&list, &groups, &facts, true);
    walk.apply(&mut list);
    assert!(list.group_cells.is_empty());

    // The disabled gate need not read the owner's cell memo. Movement during that interval
    // must still be noticed when the gate reopens, even if no owner input changes that run.
    walk.restore(&mut list);
    for vertex in &mut list.vertices {
        vertex.pos[0] += 32.0;
    }
    walk.prepare(&list, &groups, &facts, true);
    walk.apply(&mut list);
    assert!(list.group_cells.is_empty());

    walk.restore(&mut list);
    list.draws.pop();
    let mut fresh = list.clone();
    run(&mut fresh, &groups, &facts);
    walk.prepare(&list, &groups, &facts, true);
    walk.apply(&mut list);
    assert!(!list.group_cells.is_empty());
    assert_ne!(list.group_cells, expected);
    assert_eq!(list.group_cells, fresh.group_cells);
}
#[test]
fn memo_checks_vertex_uv_transform_texture_and_sampler() {
    let (mut l, g) = fixture();
    let f = facts(|x, _| x < 64);
    let mut w = run(&mut l, &g, &f);
    let original = l.group_cells.clone();
    w.restore(&mut l);
    w.prepare(&l, &g, &f, true);
    assert!(!w.apply(&mut l));
    for change in 0..5 {
        let (mut l, g) = fixture();
        let mut w = run(&mut l, &g, &f);
        w.restore(&mut l);
        match change {
            0 => {
                for v in &mut l.vertices {
                    v.pos[0] -= 32.;
                }
            }
            1 => {
                for v in &mut l.vertices {
                    v.uv[0] += 0.5;
                }
            }
            2 => l.items[0].xform[4] += 32.,
            3 => l.draws[1].sampler = Sampler::REPEAT,
            _ => (),
        }
        let revised;
        let f = if change == 4 {
            revised = facts(|_, _| true);
            &revised
        } else {
            &f
        };
        w.prepare(&l, &g, f, true);
        w.apply(&mut l);
        let mut fresh = l.clone();
        w.restore_copy(&mut fresh);
        run(&mut fresh, &g, f);
        assert_eq!(l.group_cells, fresh.group_cells, "change {change}");
        assert_ne!(
            l.group_cells, original,
            "change {change} must update the dead cells"
        );
    }
}
#[test]
fn range_remapped_after_compaction_and_clear_when_disabled() {
    let (mut l, _) = fixture();
    let f = facts(|_, _| false);
    // Two children: the first is removed, the surviving child must remain testable.
    l.draws.insert(1, l.draws[0]);
    let g = vec![GroupRange {
        first: 0,
        composite: 2..3,
    }];
    let mut w = GroupWalk::default();
    w.prepare(&l, &g, &f, true);
    l.draws.remove(0);
    w.apply_compacted(&mut l, Some((&[false, true, true], &[true])));
    assert_eq!(l.group_cells[0].draws, 0..1);
    w.restore(&mut l);
    w.prepare(&l, &[], &f, false);
    w.apply(&mut l);
    assert!(l.group_cells.is_empty());
}
#[test]
fn alpha_table_bound_and_lazy_revision_lifetime() {
    let rgba = vec![0; 2048 * 960 * 4];
    let t = alpha::AlphaTable::from_rgba8(2048, 960, &rgba).unwrap();
    assert_eq!(t.storage_bytes(), 257 * 121 * 4);
    assert!(!t.any(0, 0, 2047, 959));
    assert!(alpha::AlphaTable::from_rgba8(1, 1, &[]).is_none());
    let o = Opacity::lazy(2048, 960, rgba.into());
    o.all(); // Building the opaque table must not discard the positive-alpha input.
    assert_eq!(o.nonzero(), Some(&t));
}
#[test]
fn prediction_subtracts_only_back_buffer_fragments() {
    let (mut l, g) = fixture();
    let f = facts(|_, _| false);
    let before = fill::account(&l, &fill::FillOptions::default());
    run(&mut l, &g, &f);
    let after = fill::account(&l, &fill::FillOptions::default());
    assert_eq!(after.group_rejected_px, [128. * 128., 0., 0.]);
    assert_eq!(before.total() - after.total(), 128. * 128.);
    assert_eq!(
        before.px[fill::Class::GroupComposite as usize],
        after.px[fill::Class::GroupComposite as usize]
    );
}

#[test]
fn transformed_dead_cells_never_cover_a_positive_bilinear_sample() {
    let positive = |x: u32, y: u32| (x < 8 && y < 8) || (x >= 72 && y >= 80 && y < 88);
    for sampler in [Sampler::CLAMP, Sampler::REPEAT, Sampler::MIRROR] {
        for transform in [
            [1., 0., 0., 1., 0., 0.],
            [0.8, 0.2, -0.1, 0.7, 20., 3.],
            [-0.8, 0.1, 0.2, 0.8, 100., 0.],
        ] {
            let (mut l, g) = fixture();
            l.items[0].xform = transform;
            l.draws[1].sampler = sampler | Sampler::LINEAR;
            // An atlas subregion, with nonuniform scaling and a rotated UV axis.
            for v in &mut l.vertices {
                v.uv = [0.05 + v.uv[1] * 0.9, 0.1 + v.uv[0] * 0.8];
            }
            run(&mut l, &g, &facts(positive));
            for y in 0..128 {
                for x in 0..128 {
                    if !dead(&l, x, y) {
                        continue;
                    }
                    let [a, b, c, d, tx, ty] = transform.map(f64::from);
                    let (dx, dy) = (x as f64 + 0.5 - tx, y as f64 + 0.5 - ty);
                    let det = a * d - b * c;
                    let (lx, ly) = ((d * dx - c * dy) / det, (-b * dx + a * dy) / det);
                    if !(0.0..=128.).contains(&lx) || !(0.0..=128.).contains(&ly) {
                        continue;
                    }
                    let (u, v) = (
                        (0.05 + ly / 128. * 0.9) * 128. - 0.5,
                        (0.1 + lx / 128. * 0.8) * 128. - 0.5,
                    );
                    let wrap = |i: i32| -> u32 {
                        match sampler {
                            Sampler::CLAMP => i.clamp(0, 127) as u32,
                            Sampler::REPEAT => i.rem_euclid(128) as u32,
                            _ => {
                                let j = i.rem_euclid(256);
                                if j < 128 {
                                    j as u32
                                } else {
                                    (255 - j) as u32
                                }
                            }
                        }
                    };
                    for sy in [v.floor() as i32, v.floor() as i32 + 1] {
                        for sx in [u.floor() as i32, u.floor() as i32 + 1] {
                            assert!(
                                !positive(wrap(sx), wrap(sy)),
                                "positive sample under dead pixel ({x},{y})"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn multiple_composite_draws_union_live_footprints() {
    let (mut l, mut g) = fixture();
    let mut second = l.draws[1];
    let base = l.vertices.len() as u32;
    let verts: Vec<_> = l
        .vertices
        .iter()
        .map(|v| Vertex {
            uv: [v.uv[0] + 0.5, v.uv[1]],
            ..*v
        })
        .collect();
    l.vertices.extend(verts);
    second.first_index = l.indices.len() as u32;
    l.indices.extend([0, 1, 2, 0, 2, 3].map(|i| i + base));
    l.draws.push(second);
    g[0].composite.end += 1;
    run(&mut l, &g, &facts(|x, _| x >= 64));
    assert!(
        l.group_cells.is_empty(),
        "second draw keeps the left half live too"
    );
}

#[test]
fn changed_cell_facts_do_not_dirty_unchanged_draws() {
    let (mut l, g) = fixture();
    let mut w = run(&mut l, &g, &facts(|_, _| true));
    assert!(l.group_cells.is_empty());
    w.restore(&mut l);
    w.prepare(&l, &g, &facts(|_, _| false), true);
    assert!(!w.apply(&mut l), "optional cell facts do not change the draw table");
    assert!(!l.group_cells.is_empty());
}

#[test]
fn merged_groups_remap_cells_restore_and_reuse_the_memo() {
    let (mut l, mut g) = fixture();
    l.target.width = 288;
    l.vertices
        .extend(l.vertices.clone().into_iter().map(|mut v| {
            v.pos[0] += 160.;
            v
        }));
    l.indices.extend([4, 5, 6, 4, 6, 7]);
    l.draws.extend(l.draws.clone().into_iter().map(|mut d| {
        d.first_index = 6;
        d
    }));
    l.screen_ops[0].region = [0, 0, 288, 128];
    l.screen_ops.push(ScreenOp {
        before: 2,
        ..l.screen_ops[0]
    });
    g.push(GroupRange {
        first: 2,
        composite: 3..4,
    });
    let f = facts(|x, y| x < 8 && y < 8);
    let mut w = run(&mut l, &g, &f);
    let plain = l.clone();
    assert_eq!(plain.group_cells.len(), 2);
    assert_eq!(plain.group_cells[0].draws, 2..3);
    assert_eq!(plain.group_cells[1].draws, 0..1);
    assert!(w.merge(&mut l, &f, true));
    assert_eq!(l.group_cells[0].draws, 1..2);
    assert_eq!(l.group_cells[1].draws, 0..1);
    assert_eq!(l.group_cells[0].rects, plain.group_cells[0].rects);
    assert_eq!(l.group_cells[1].rects, plain.group_cells[1].rects);
    assert!(
        l.draws[..2]
            .iter()
            .all(|d| d.flags & DRAW_TO_BACK_BUFFER != 0)
    );
    assert!(l.draws[2..].iter().all(|d| d.flags & DRAW_GROUP_CLIP != 0));
    assert!(w.check_merge(&plain, &l));
    for change_rect in [false, true] {
        let mut wrong = l.clone();
        if change_rect {
            wrong.group_cells[1].rects[0][0] += 1;
        } else {
            wrong.group_cells[0].draws = 2..3;
        }
        assert!(!w.check_merge(&plain, &wrong));
    }
    let mut restored = l.clone();
    w.restore_merge_copy(&mut restored);
    assert_eq!(format!("{restored:?}"), format!("{plain:?}"));
    let merged = l.clone();
    // An unchanged apply restores the original ranges before consulting the verified memo.
    for _ in 0..2 {
        w.restore(&mut l);
        assert_eq!(l.group_cells, plain.group_cells);
        w.prepare(&l, &g, &f, true);
        assert!(!w.apply(&mut l));
        assert!(!w.merge(&mut l, &f, true));
        assert_eq!(format!("{l:?}"), format!("{merged:?}"));
    }
}
