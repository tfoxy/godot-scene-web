use super::*;
use crate::*;
use std::collections::HashMap;

#[derive(Default)]
struct Facts {
    revisions: HashMap<u32, u32>,
    time: Vec<bool>,
    programs: Vec<ProgramFacts>,
    program_revision: u32,
    denied: Vec<usize>,
}
impl DamageFacts for Facts {
    fn texture_revision(&self, id: u32) -> u32 {
        self.revisions.get(&id).copied().unwrap_or(0)
    }
    fn program(&self, slot: u32) -> ProgramFacts {
        self.programs
            .get(slot as usize)
            .copied()
            .unwrap_or(ProgramFacts {
                reads_screen: false,
                vertex_stage: false,
                alpha: None,
            })
    }
    fn reads_time(&self, slot: u32) -> bool {
        self.time.get(slot as usize).copied().unwrap_or(false)
    }
    fn program_revision(&self, _: u32) -> u32 {
        self.program_revision
    }
    fn admitted(&self, list: &DrawList, d: usize) -> bool {
        list.draws[d].index_count > 0 && !self.denied.contains(&d)
    }
}
fn opts() -> PlanOptions {
    PlanOptions {
        cell: 8,
        regions_max: 100,
        area_max: 1.,
        calls_max: 100.,
    }
}
fn list() -> DrawList {
    DrawList {
        target: Target {
            width: 128,
            height: 128,
            ..Target::default()
        },
        ..DrawList::default()
    }
}
fn quad(l: &mut DrawList, r: [f32; 4]) -> usize {
    let item = l.items.len() as u32;
    l.items.push(Item {
        xform: [1., 0., 0., 1., 0., 0.],
        modulate: [1.; 4],
        ..Item::default()
    });
    let base = l.vertices.len() as u32;
    for pos in [
        [r[0], r[1]],
        [r[0] + r[2], r[1]],
        [r[0] + r[2], r[1] + r[3]],
        [r[0], r[1] + r[3]],
    ] {
        l.vertices.push(Vertex {
            pos,
            uv: [0.; 2],
            color: [1.; 4],
            item,
        });
    }
    let first_index = l.indices.len() as u32;
    l.indices
        .extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    l.draws.push(Draw {
        first_index,
        index_count: 6,
        ..Draw::default()
    });
    l.draws.len() - 1
}
// Route every test plan through the same replay-safety checks, including plans that
// are only inspected for their statistics or discarded before commit.
struct CheckedPlanner(Planner);
impl CheckedPlanner {
    fn plan(
        &mut self,
        list: &DrawList,
        facts: &impl DamageFacts,
        opts: &PlanOptions,
    ) -> (Plan, PlanStats) {
        let result = self.0.plan(list, facts, opts);
        if let Plan::Partial {
            regions,
            back_regions,
        } = &result.0
        {
            assert_disjoint(regions);
            assert_disjoint(back_regions);
        }
        result
    }
    fn commit(&mut self) {
        self.0.commit();
    }
    fn invalidate(&mut self) {
        self.0.invalidate();
    }
}
fn assert_disjoint(regions: &[[i32; 4]]) {
    for (i, a) in regions.iter().enumerate() {
        for b in &regions[i + 1..] {
            assert!(
                !PxRect::xywh(*a).intersects(&PxRect::xywh(*b)),
                "overlapping regions {a:?} and {b:?} in {regions:?}"
            );
        }
    }
}
fn seed(l: &DrawList, f: &Facts) -> CheckedPlanner {
    let mut p = CheckedPlanner(Planner::new());
    assert_eq!(p.plan(l, f, &opts()).0, Plan::Full(FullReason::First));
    p.commit();
    p
}
fn partial(plan: Plan) -> Vec<[i32; 4]> {
    match plan {
        Plan::Partial { regions, .. } => regions,
        p => panic!("expected Partial, got {p:?}"),
    }
}
fn covers(regions: &[[i32; 4]], r: [i32; 4]) -> bool {
    // Check every pixel, allowing coverage by several disjoint regions.
    (r[1]..r[1] + r[3]).all(|y| {
        (r[0]..r[0] + r[2]).all(|x| {
            regions
                .iter()
                .any(|s| x >= s[0] && x < s[0] + s[2] && y >= s[1] && y < s[1] + s[3])
        })
    })
}
#[test]
fn identical_lists_skip() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    let (plan, s) = p.plan(&l, &f, &opts());
    assert_eq!(plan, Plan::Skip);
    assert_eq!(s.matched, 1);
}
#[test]
fn moved_item_damages_old_and_new_only() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [80., 80., 8., 8.]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].xform[4] = 24.;
    let (plan, s) = p.plan(&l, &f, &opts());
    let r = partial(plan);
    assert_eq!(r, vec![[8, 8, 8, 8], [32, 8, 8, 8]]);
    assert_eq!((s.changed_old, s.changed_new, s.matched), (1, 1, 1));
}
#[test]
fn z_swap_of_overlapping_draws_damages_both() {
    let mut l = list();
    quad(&mut l, [8., 8., 16., 16.]);
    quad(&mut l, [8., 8., 16., 16.]);
    l.draws[1].texture = 2;
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.draws.swap(0, 1);
    let (plan, s) = p.plan(&l, &f, &opts());
    assert!(covers(&partial(plan), [8, 8, 16, 16]));
    assert!(s.structural);
}
#[test]
fn earlier_geometry_growth_preserves_later_index_shift() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [80., 80., 8., 8.]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    let mut extra = l.vertices[0];
    extra.pos[0] += 2.;
    l.vertices.insert(4, extra);
    for i in &mut l.indices {
        if *i >= 4 {
            *i += 1;
        }
    }
    l.indices.splice(6..6, [0, 1, 4]);
    l.draws[0].index_count += 3;
    l.draws[1].first_index += 3;
    let (plan, s) = p.plan(&l, &f, &opts());
    assert_eq!(partial(plan), vec![[8, 8, 8, 8]]);
    assert_eq!(s.matched, 1);
}
#[test]
fn texture_revision_damages_its_draw() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [80., 80., 8., 8.]);
    l.draws[0].texture = 7;
    let mut f = Facts::default();
    let mut p = seed(&l, &f);
    f.revisions.insert(7, 1);
    assert_eq!(partial(p.plan(&l, &f, &opts()).0), vec![[8, 8, 8, 8]]);
}
#[test]
fn admission_flip_damages_bounds() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    let mut f = Facts {
        denied: vec![0],
        ..Facts::default()
    };
    let mut p = seed(&l, &f);
    f.denied.clear();
    assert_eq!(partial(p.plan(&l, &f, &opts()).0), vec![[8, 8, 8, 8]]);
}
fn bind(l: &mut DrawList, d: usize) {
    l.bindings.push(Binding {
        program: l.bindings.len() as u32 + 10,
        post_modulate: [1.; 4],
        ..Binding::default()
    });
    l.draws[d].program = l.bindings.len() as u32;
}
#[test]
fn shader_time_only_damages_time_readers() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [80., 80., 8., 8.]);
    bind(&mut l, 0);
    bind(&mut l, 1);
    let f = Facts {
        time: vec![true, false],
        ..Facts::default()
    };
    let mut p = seed(&l, &f);
    l.shader_time = 2.;
    assert_eq!(partial(p.plan(&l, &f, &opts()).0), vec![[8, 8, 8, 8]]);
}
#[test]
fn shader_time_without_readers_skips() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    bind(&mut l, 0);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.shader_time = 99.;
    assert_eq!(p.plan(&l, &f, &opts()).0, Plan::Skip);
}
#[test]
fn first_target_change_and_dirty_all_are_full() {
    let mut l = list();
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.target.width += 1;
    assert_eq!(
        p.plan(&l, &f, &opts()).0,
        Plan::Full(FullReason::Invalidated)
    );
    p.commit();
    l.dirty.all = true;
    assert_eq!(p.plan(&l, &f, &opts()).0, Plan::Full(FullReason::DirtyAll));
}
#[test]
fn target_identity_uses_clear_bits_format_opaque_and_surface() {
    for field in 0..4 {
        let mut l = list();
        let f = Facts::default();
        let mut p = seed(&l, &f);
        match field {
            0 => l.target.clear[0] = -0.,
            1 => l.target.format = Format::Rgba8,
            2 => l.target.opaque = true,
            _ => l.target.surface = 1,
        }
        assert_eq!(
            p.plan(&l, &f, &opts()).0,
            Plan::Full(FullReason::Invalidated)
        );
    }
}
#[test]
fn t_shaped_damage_preserves_clean_corners() {
    let mut l = list();
    quad(&mut l, [8., 8., 24., 8.]);
    quad(&mut l, [16., 16., 8., 16.]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    for row in &mut l.items {
        row.modulate[0] = 0.5;
    }
    let r = partial(p.plan(&l, &f, &opts()).0);
    assert_eq!(r.len(), 2);
    assert!(!covers(&r, [8, 16, 1, 1]));
    assert!(!covers(&r, [24, 16, 1, 1]));
}
#[test]
fn too_many_regions_use_union() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [32., 32., 8., 8.]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    for row in &mut l.items {
        row.modulate[0] = 0.5;
    }
    assert_eq!(
        partial(
            p.plan(
                &l,
                &f,
                &PlanOptions {
                    regions_max: 1,
                    ..opts()
                }
            )
            .0
        ),
        vec![[8, 8, 32, 32]]
    );
}
#[test]
fn area_threshold_is_full() {
    let mut l = list();
    quad(&mut l, [0., 0., 96., 96.]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    assert_eq!(
        p.plan(
            &l,
            &f,
            &PlanOptions {
                area_max: 0.5,
                ..opts()
            }
        )
        .0,
        Plan::Full(FullReason::Area)
    );
}
#[test]
fn calls_threshold_is_full() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    assert_eq!(
        p.plan(
            &l,
            &f,
            &PlanOptions {
                calls_max: 0.75,
                ..opts()
            }
        )
        .0,
        Plan::Full(FullReason::Calls)
    );
}
#[test]
fn invalidate_discards_pending_reference() {
    let l = list();
    let f = Facts::default();
    let mut p = seed(&l, &f);
    p.plan(&l, &f, &opts());
    p.invalidate();
    p.commit();
    assert_eq!(
        p.plan(&l, &f, &opts()).0,
        Plan::Full(FullReason::Invalidated)
    );
}
#[test]
fn uncommitted_plan_does_not_advance_reference() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    let first = p.plan(&l, &f, &opts()).0;
    assert_eq!(p.plan(&l, &f, &opts()).0, first);
    p.commit();
    assert_eq!(p.plan(&l, &f, &opts()).0, Plan::Skip);
}
#[test]
fn binding_values_names_sampler_and_program_revision_are_hashed() {
    for field in 0..9 {
        let mut l = list();
        quad(&mut l, [8., 8., 8., 8.]);
        bind(&mut l, 0);
        l.bindings[0].uniforms.push(Uniform {
            name: "u".into(),
            value: UniformValue::Float(vec![1.]),
        });
        l.bindings[0].samplers.push(SamplerUniform {
            name: "s".into(),
            texture: 5,
            sampler: 0,
        });
        let mut f = Facts::default();
        let mut p = seed(&l, &f);
        let b = &mut l.bindings[0];
        match field {
            0 => b.program += 1,
            1 => f.program_revision += 1,
            2 => b.post_modulate[0] = 0.5,
            3 => b.uniforms[0].name = "v".into(),
            4 => b.uniforms[0].value = UniformValue::Int(vec![1]),
            5 => b.samplers[0].sampler = 1,
            6 => b.samplers[0].name = "t".into(),
            7 => {
                f.revisions.insert(5, 1);
            }
            _ => b.samplers[0].texture = 6,
        }
        assert_eq!(
            partial(p.plan(&l, &f, &opts()).0),
            vec![[8, 8, 8, 8]],
            "field {field}"
        );
    }
}
#[test]
fn instanced_content_is_hashed_but_storage_offsets_are_not() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    l.draws[0].flags |= DRAW_INSTANCED;
    l.instances.push(Instance::IDENTITY);
    l.instanced.push(InstancedDraw {
        draw: 0,
        first: 0,
        count: 1,
    });
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.instances.insert(0, Instance::IDENTITY);
    l.instanced[0].first = 1;
    assert_eq!(p.plan(&l, &f, &opts()).0, Plan::Skip);
    l.instances[1].custom[0] = 1.;
    assert_eq!(partial(p.plan(&l, &f, &opts()).0), vec![[8, 8, 8, 8]]);
}
#[test]
fn item_row_relocation_and_screen_flag_do_not_damage() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items.insert(0, Item::default());
    for v in &mut l.vertices {
        v.item += 1;
    }
    l.draws[0].flags |= DRAW_SCREEN_OPS;
    assert_eq!(p.plan(&l, &f, &opts()).0, Plan::Skip);
}
#[test]
fn duplicate_hashes_and_insertions_preserve_order() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [32., 32., 8., 8.]);
    l.draws.push(l.draws[0]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    quad(&mut l, [80., 80., 8., 8.]);
    let (plan, s) = p.plan(&l, &f, &opts());
    assert_eq!(partial(plan), vec![[80, 80, 8, 8]]);
    assert_eq!(s.changed_old, 0);
    assert!(s.structural);
}
#[test]
fn vertex_stage_bounds_use_the_scissor() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    bind(&mut l, 0);
    l.draws[0].flags |= DRAW_SCISSOR;
    l.draws[0].scissor = [32, 32, 16, 16];
    let f = Facts {
        programs: vec![ProgramFacts {
            reads_screen: false,
            vertex_stage: true,
            alpha: None,
        }],
        ..Facts::default()
    };
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    assert_eq!(partial(p.plan(&l, &f, &opts()).0), vec![[32, 32, 16, 16]]);
}
#[test]
fn regions_are_disjoint_and_edge_tiles_are_clipped() {
    let mut m = Mask::new(19, 19, 8);
    m.add(PxRect::xywh([8, 0, 11, 19]));
    assert_eq!(m.regions(8), vec![[8, 0, 11, 19]]);
}

fn op(l: &mut DrawList, before: usize, kind: ScreenOpKind, region: [i32; 4]) {
    l.screen_ops.push(ScreenOp {
        before: before as u32,
        kind,
        region,
        mipmaps: false,
        sample_mips: false,
    });
    l.draws[before].flags |= DRAW_SCREEN_OPS;
}
fn group(l: &mut DrawList, d: usize) {
    l.draws[d].flags |= DRAW_GROUP_CLIP;
}
#[test]
fn clip_copy_expands_changed_source_to_region_and_reader() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [40., 8., 8., 8.]);
    group(&mut l, 1);
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    op(&mut l, 1, ScreenOpKind::Copy, [0, 0, 32, 32]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    let r = partial(p.plan(&l, &f, &opts()).0);
    assert!(covers(&r, [0, 0, 32, 32]));
    assert!(covers(&r, [40, 8, 8, 8]));
}
#[test]
fn change_far_from_copy_does_not_expand() {
    let mut l = list();
    quad(&mut l, [96., 96., 8., 8.]);
    quad(&mut l, [8., 8., 8., 8.]);
    group(&mut l, 1);
    op(&mut l, 1, ScreenOpKind::Copy, [0, 0, 32, 32]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    assert_eq!(partial(p.plan(&l, &f, &opts()).0), vec![[96, 96, 8, 8]]);
}
#[test]
fn transparent_child_change_damages_composite_and_dilates_back_regions() {
    let mut l = list();
    quad(&mut l, [32., 32., 8., 8.]);
    quad(&mut l, [32., 32., 8., 8.]);
    l.draws[0].flags |= DRAW_TO_BACK_BUFFER;
    l.draws[1].flags |= DRAW_GROUP_COMPOSITE;
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    let (plan, s) = p.plan(&l, &f, &opts());
    assert_eq!(
        plan,
        Plan::Partial {
            regions: vec![[32, 32, 8, 8]],
            back_regions: vec![[24, 24, 24, 24]]
        }
    );
    assert_eq!((s.changed_old, s.changed_new, s.history_reads), (2, 2, 0));
    assert_eq!(s.admitted_draws, 2);
}
#[test]
fn mipmap_reader_expands_region_and_reader() {
    for copied in [false, true] {
        let mut l = list();
        quad(&mut l, [8., 8., 8., 8.]);
        quad(&mut l, [48., 48., 8., 8.]);
        group(&mut l, 1);
        op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
        op(
            &mut l,
            1,
            if copied {
                ScreenOpKind::Copy
            } else {
                ScreenOpKind::Mipmaps
            },
            [0, 0, 32, 32],
        );
        l.screen_ops[1].mipmaps = copied;
        l.screen_ops[1].sample_mips = true;
        let f = Facts::default();
        let mut p = seed(&l, &f);
        l.items[0].modulate[0] = 0.5;
        let r = partial(p.plan(&l, &f, &opts()).0);
        assert!(covers(&r, [0, 0, 32, 32]));
        assert!(covers(&r, [48, 48, 8, 8]));
    }
}
#[test]
fn mipmap_without_sampling_does_not_expand() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [48., 48., 8., 8.]);
    group(&mut l, 1);
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    op(&mut l, 1, ScreenOpKind::Mipmaps, [0, 0, 32, 32]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    assert_eq!(partial(p.plan(&l, &f, &opts()).0), vec![[8, 8, 8, 8]]);
}
#[test]
fn item_screen_reader_intersection_is_full_otherwise_partial() {
    for near in [false, true] {
        let mut l = list();
        quad(
            &mut l,
            if near {
                [8., 8., 8., 8.]
            } else {
                [96., 96., 8., 8.]
            },
        );
        quad(&mut l, [8., 8., 8., 8.]);
        bind(&mut l, 1);
        op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
        let f = Facts {
            programs: vec![ProgramFacts {
                reads_screen: true,
                vertex_stage: false,
                alpha: None,
            }],
            ..Facts::default()
        };
        let mut p = seed(&l, &f);
        l.items[0].modulate[0] = 0.5;
        let plan = p.plan(&l, &f, &opts()).0;
        if near {
            assert_eq!(plan, Plan::Full(FullReason::ScreenReader));
        } else {
            assert_eq!(partial(plan), vec![[96, 96, 8, 8]]);
        }
    }
}
#[test]
fn history_is_full_even_after_full_and_without_damage() {
    let mut l = list();
    quad(&mut l, [96., 96., 8., 8.]);
    quad(&mut l, [8., 8., 8., 8.]);
    group(&mut l, 1);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    for _ in 0..2 {
        let (plan, stats) = p.plan(&l, &f, &opts());
        assert_eq!(plan, Plan::Full(FullReason::HistoryRead));
        assert_eq!(stats.history_reads, 1);
        p.commit();
    }
    // An explicit fresh clear removes the history dependency.
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    assert!(matches!(p.plan(&l, &f, &opts()).0, Plan::Partial { .. }));
    p.commit();
    assert_eq!(p.plan(&l, &f, &opts()).0, Plan::Skip);
}
#[test]
fn earlier_writes_cover_union_without_rounding_holes() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [0., 0., 1., 1.]);
    group(&mut l, 0);
    // A full-frame pair of copies covers the reader's grown footprint, though neither alone does.
    op(&mut l, 0, ScreenOpKind::Copy, [0, 0, 12, 32]);
    op(&mut l, 0, ScreenOpKind::Copy, [12, 0, 20, 32]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    assert_eq!(p.plan(&l, &f, &opts()).1.history_reads, 0);
    l.screen_ops[1].region[0] = 13;
    assert_eq!(p.plan(&l, &f, &opts()).1.history_reads, 1);
}
#[test]
fn two_copy_chain_expands_to_fixed_point() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [64., 8., 8., 8.]);
    quad(&mut l, [32., 8., 8., 8.]);
    group(&mut l, 1);
    group(&mut l, 2);
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    op(&mut l, 1, ScreenOpKind::Copy, [32, 0, 16, 24]);
    op(&mut l, 2, ScreenOpKind::Copy, [8, 0, 16, 24]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    let r = partial(p.plan(&l, &f, &opts()).0);
    assert!(covers(&r, [32, 0, 16, 24]));
    assert!(covers(&r, [64, 8, 8, 8]));
    assert!(covers(&r, [8, 0, 16, 24]));
}
#[test]
fn unmatched_producer_damages_its_bounds_but_clear_does_not() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    l.draws[0].flags |= DRAW_TO_BACK_BUFFER;
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    l.screen_ops[0].region = [8, 8, 8, 8];
    assert_eq!(partial(p.plan(&l, &f, &opts()).0), vec![[8, 8, 8, 8]]);
}
#[test]
fn clear_resets_back_input_hash_before_reader() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [32., 32., 8., 8.]);
    group(&mut l, 1);
    l.draws[0].flags |= DRAW_TO_BACK_BUFFER;
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    // The producer itself is conservatively damaged, but Clear keeps the reader matched.
    let (plan, stats) = p.plan(&l, &f, &opts());
    assert_eq!(partial(plan), vec![[8, 8, 8, 8]]);
    assert_eq!((stats.changed_old, stats.changed_new), (1, 1));
}
#[test]
fn union_fallback_rechecks_screen_readers() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [32., 32., 8., 8.]);
    quad(&mut l, [24., 24., 8., 8.]);
    bind(&mut l, 2);
    op(&mut l, 2, ScreenOpKind::Clear, [0; 4]);
    let f = Facts {
        programs: vec![ProgramFacts {
            reads_screen: true,
            vertex_stage: false,
            alpha: None,
        }],
        ..Facts::default()
    };
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    l.items[1].modulate[0] = 0.5;
    assert!(matches!(p.plan(&l, &f, &opts()).0, Plan::Partial { .. }));
    assert_eq!(
        p.plan(
            &l,
            &f,
            &PlanOptions {
                regions_max: 1,
                ..opts()
            }
        )
        .0,
        Plan::Full(FullReason::ScreenReader)
    );
}
#[test]
fn skipped_reader_does_not_force_full_or_read_history() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [8., 8., 8., 8.]);
    bind(&mut l, 1);
    let f = Facts {
        programs: vec![ProgramFacts::UNKNOWN],
        denied: vec![1],
        ..Facts::default()
    };
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    let (plan, s) = p.plan(&l, &f, &opts());
    assert!(matches!(plan, Plan::Partial { .. }));
    assert_eq!(s.history_reads, 0);
}

#[test]
fn back_draw_bounds_do_not_certify_fresh_history_pixels() {
    let mut l = list();
    quad(&mut l, [96., 96., 8., 8.]);
    quad(&mut l, [0., 0., 128., 128.]);
    l.draws[1].flags |= DRAW_TO_BACK_BUFFER;
    quad(&mut l, [96., 96., 8., 8.]);
    group(&mut l, 2);
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    assert!(matches!(p.plan(&l, &f, &opts()).0, Plan::Partial { .. }));
    p.commit();
    // The partial frame clears the back buffer, but repaints its white quad only around
    // (96,96). At (24,24) the retained back buffer is transparent; a full replay leaves white.
    let mut next = list();
    quad(&mut next, [96., 96., 8., 8.]);
    next.items[0].modulate[0] = 0.5;
    quad(&mut next, [8., 8., 24., 24.]);
    // Only the upper-left triangle is drawn (x + y <= 40). Its bounds contain the
    // lower-right reader, but none of that reader's pixels are freshly written.
    let first = next.draws[1].first_index as usize;
    next.indices[first..first + 3].copy_from_slice(&[4, 5, 7]);
    next.draws[1].index_count = 3;
    next.draws[1].flags |= DRAW_TO_BACK_BUFFER;
    quad(&mut next, [24., 24., 4., 4.]);
    group(&mut next, 2);
    // Replaying only the planned regions would sample transparent history in this composite,
    // whereas a sequence of full redraws samples white. Bounds cannot certify fresh writes.
    assert_eq!(
        p.plan(&next, &f, &opts()).0,
        Plan::Full(FullReason::HistoryRead)
    );
}

#[test]
fn mipmap_generation_reads_history_even_without_a_later_reader() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    op(&mut l, 0, ScreenOpKind::Mipmaps, [0, 0, 32, 32]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    let (plan, stats) = p.plan(&l, &f, &opts());
    assert_eq!(plan, Plan::Full(FullReason::HistoryRead));
    assert_eq!(stats.history_reads, 1);
}

#[test]
fn clear_makes_mipmap_generation_fresh_but_a_draw_does_not() {
    for clear in [false, true] {
        let mut l = list();
        quad(&mut l, [0., 0., 32., 32.]);
        l.draws[0].flags |= DRAW_TO_BACK_BUFFER;
        quad(&mut l, [8., 8., 8., 8.]);
        if clear {
            op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
        }
        op(&mut l, 1, ScreenOpKind::Mipmaps, [0, 0, 32, 32]);
        let f = Facts::default();
        let mut p = seed(&l, &f);
        assert_eq!(
            p.plan(&l, &f, &opts()).0,
            if clear {
                Plan::Skip
            } else {
                Plan::Full(FullReason::HistoryRead)
            }
        );
    }
}

#[test]
fn mip_sampling_requires_a_chain_built_this_frame() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    group(&mut l, 0);
    op(&mut l, 0, ScreenOpKind::Copy, [0, 0, 128, 128]);
    l.screen_ops[0].sample_mips = true;
    let f = Facts::default();
    let mut p = seed(&l, &f);
    assert_eq!(
        p.plan(&l, &f, &opts()).0,
        Plan::Full(FullReason::HistoryRead)
    );
    l.screen_ops[0].mipmaps = true;
    assert_eq!(p.plan(&l, &f, &opts()).1.history_reads, 0);
}

#[test]
fn unexecuted_trailing_mipmap_op_does_not_read_history() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [24., 24., 8., 8.]);
    op(&mut l, 1, ScreenOpKind::Mipmaps, [0, 0, 32, 32]);
    let f = Facts {
        denied: vec![1],
        ..Facts::default()
    };
    let mut p = seed(&l, &f);
    assert_eq!(p.plan(&l, &f, &opts()).0, Plan::Skip);
}

#[test]
fn mipmap_input_signature_survives_a_level_zero_clear() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    l.draws[0].flags |= DRAW_TO_BACK_BUFFER;
    quad(&mut l, [8., 8., 8., 8.]);
    bind(&mut l, 1);
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    op(&mut l, 1, ScreenOpKind::Mipmaps, [0, 0, 32, 32]);
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    l.screen_ops[2].sample_mips = true;
    let f = Facts {
        programs: vec![ProgramFacts {
            reads_screen: true,
            vertex_stage: false,
            alpha: None,
        }],
        ..Facts::default()
    };
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    assert_eq!(
        p.plan(&l, &f, &opts()).0,
        Plan::Full(FullReason::ScreenReader)
    );
}

fn screen_facts() -> Facts {
    Facts {
        programs: vec![ProgramFacts {
            reads_screen: true,
            vertex_stage: false,
            alpha: None,
        }],
        ..Facts::default()
    }
}

#[test]
fn regression_copy_moved_across_target_draw() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [96., 96., 8., 8.]);
    bind(&mut l, 2);
    l.items[0].modulate = [1., 0., 0., 1.];
    l.items[1].modulate = [0., 0., 1., 1.];
    op(&mut l, 1, ScreenOpKind::Copy, [0, 0, 128, 128]);
    let facts = screen_facts();
    let mut p = seed(&l, &facts);
    l.screen_ops[0].before = 2;
    l.draws[1].flags &= !DRAW_SCREEN_OPS;
    l.draws[2].flags |= DRAW_SCREEN_OPS;
    assert_eq!(
        p.plan(&l, &facts, &opts()).0,
        Plan::Full(FullReason::ScreenReader)
    );
}

#[test]
fn regression_target_draw_moved_across_fixed_copy() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [96., 96., 8., 8.]);
    bind(&mut l, 2);
    l.items[0].modulate = [1., 0., 0., 1.];
    l.items[1].modulate = [0., 0., 1., 1.];
    op(&mut l, 1, ScreenOpKind::Copy, [0, 0, 128, 128]);
    let facts = screen_facts();
    let mut p = seed(&l, &facts);
    l.draws.swap(0, 1);
    l.draws[0].flags &= !DRAW_SCREEN_OPS;
    l.draws[1].flags |= DRAW_SCREEN_OPS;
    assert_eq!(l.screen_ops[0].before, 1);
    assert_eq!(
        p.plan(&l, &facts, &opts()).0,
        Plan::Full(FullReason::ScreenReader)
    );
}

#[test]
fn regression_disjoint_copy_keeps_earlier_copy_reader() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [64., 64., 8., 8.]);
    quad(&mut l, [96., 96., 8., 8.]);
    bind(&mut l, 2);
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    op(&mut l, 1, ScreenOpKind::Copy, [0, 0, 32, 32]);
    op(&mut l, 2, ScreenOpKind::Copy, [64, 64, 16, 16]);
    let facts = screen_facts();
    let mut p = seed(&l, &facts);
    l.items[0].modulate[0] = 0.5;
    assert_eq!(
        p.plan(&l, &facts, &PlanOptions::default()).0,
        Plan::Full(FullReason::ScreenReader)
    );
}

#[test]
fn regression_partial_fill_uses_dilated_back_regions() {
    use crate::fill::{self, Class, FillOptions};
    let mut l = list();
    quad(&mut l, [96., 96., 8., 8.]);
    quad(&mut l, [0., 0., 128., 128.]);
    l.draws[1].flags |= DRAW_TO_BACK_BUFFER;
    quad(&mut l, [96., 96., 8., 8.]);
    l.draws[2].flags |= DRAW_GROUP_COMPOSITE;
    for r in [[8., 8., 8., 8.], [48., 8., 8., 8.], [8., 48., 8., 8.]] {
        quad(&mut l, r);
    }
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    let facts = Facts::default();
    let mut p = seed(&l, &facts);
    l.items[0].modulate[0] = 0.5;
    let Plan::Partial {
        regions,
        back_regions,
    } = p.plan(&l, &facts, &PlanOptions::default()).0
    else {
        panic!("small target change must be partial");
    };
    assert_eq!(regions, vec![[96, 96, 32, 32]]);
    assert_eq!(back_regions, vec![[64, 64, 64, 64]]);
    let px = fill::account_partial(&l, &FillOptions::default(), &regions, &back_regions);
    assert_eq!(px[Class::ToBackBuffer as usize], 4096.);
    assert_eq!(px[Class::Clear as usize], 1024.);
    assert_eq!(px[Class::Present as usize], 1024.);
    assert_eq!(px[Class::BackBufferClear as usize], 16384.);
}

#[test]
fn disjoint_mipmap_regions_keep_earlier_dependencies() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [96., 96., 8., 8.]);
    bind(&mut l, 1);
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    op(&mut l, 1, ScreenOpKind::Mipmaps, [0, 0, 32, 32]);
    op(&mut l, 1, ScreenOpKind::Mipmaps, [64, 64, 16, 16]);
    l.screen_ops[2].sample_mips = true;
    let f = screen_facts();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    assert_eq!(
        p.plan(&l, &f, &opts()).0,
        Plan::Full(FullReason::ScreenReader)
    );
}

#[test]
fn clear_ends_earlier_copy_dependencies() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [96., 96., 8., 8.]);
    bind(&mut l, 1);
    op(&mut l, 1, ScreenOpKind::Copy, [0, 0, 32, 32]);
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    let f = screen_facts();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    assert_eq!(partial(p.plan(&l, &f, &opts()).0), vec![[8, 8, 8, 8]]);
}

#[test]
fn unmatched_copy_damages_region_and_counts_ops_separately() {
    let mut l = list();
    quad(&mut l, [96., 96., 8., 8.]);
    op(&mut l, 0, ScreenOpKind::Copy, [0, 0, 16, 16]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.screen_ops[0].region[0] = 32;
    let (plan, stats) = p.plan(&l, &f, &opts());
    assert_eq!(partial(plan), vec![[0, 0, 16, 16], [32, 0, 16, 16]]);
    assert_eq!(
        (stats.changed_old, stats.changed_new, stats.matched),
        (0, 0, 1)
    );
    assert_eq!((stats.changed_old_ops, stats.changed_new_ops), (1, 1));
}

#[test]
fn full_fallback_reports_reader_and_mipmap_triggers() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    bind(&mut l, 0);
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    let f = screen_facts();
    let mut p = seed(&l, &f);
    l.items[0].modulate[0] = 0.5;
    let (plan, stats) = p.plan(&l, &f, &opts());
    assert_eq!(plan, Plan::Full(FullReason::ScreenReader));
    assert_eq!(
        stats.full_triggers,
        vec![FullTrigger {
            draw: 0,
            op: None,
            program_slot: Some(0),
            bounds: [8, 8, 8, 8]
        }]
    );
    l.screen_ops.clear();
    let (plan, stats) = p.plan(&l, &f, &opts());
    assert_eq!(plan, Plan::Full(FullReason::HistoryRead));
    assert_eq!(
        stats.full_triggers,
        vec![FullTrigger {
            draw: 0,
            op: None,
            program_slot: Some(0),
            bounds: [8, 8, 8, 8]
        }]
    );
    l.draws[0].program = 0;
    op(&mut l, 0, ScreenOpKind::Mipmaps, [0, 0, 32, 32]);
    let (plan, stats) = p.plan(&l, &f, &opts());
    assert_eq!(plan, Plan::Full(FullReason::HistoryRead));
    assert_eq!(
        stats.full_triggers,
        vec![FullTrigger {
            draw: 0,
            op: Some(0),
            program_slot: None,
            bounds: [0, 0, 32, 32]
        }]
    );
}

#[test]
fn partial_fill_counts_operations_once_across_multiple_regions() {
    use crate::fill::{self, Class, FillOptions};
    let mut l = list();
    quad(&mut l, [0., 0., 128., 128.]);
    l.draws[0].flags |= DRAW_TO_BACK_BUFFER;
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    op(&mut l, 0, ScreenOpKind::Copy, [0, 0, 64, 64]);
    l.screen_ops[1].mipmaps = true;
    let px = fill::account_partial(
        &l,
        &FillOptions::default(),
        &[[0, 0, 8, 8], [32, 32, 8, 8]],
        &[[0, 0, 16, 16], [32, 32, 16, 16]],
    );
    assert_eq!(px[Class::Clear as usize], 128.);
    assert_eq!(px[Class::Present as usize], 128.);
    assert_eq!(px[Class::ToBackBuffer as usize], 512.);
    assert_eq!(px[Class::BackBufferClear as usize], 16384.);
    assert_eq!(px[Class::Copy as usize], 4096.);
    assert_eq!(px[Class::Mipmaps as usize], 4096. / 3.);
}

#[test]
fn regression_recursive_patience_matches_repeated_entries() {
    let sigs = |hashes: &[u64]| {
        hashes
            .iter()
            .map(|&hash| signature::DrawSig {
                hash,
                bounds: PxRect::EMPTY,
                is_op: false,
            })
            .collect::<Vec<_>>()
    };
    // The repeated entries become unambiguous only within the gaps between anchors.
    let a = sigs(&[1, 99, 10, 2, 99, 20, 3, 99, 30, 4]);
    let b = sigs(&[5, 99, 10, 6, 99, 20, 7, 99, 30, 8]);
    assert_eq!(
        diff::unmatched(&a, &b),
        (vec![0, 3, 6, 9], vec![0, 3, 6, 9])
    );
    // Even the inner anchors repeat globally. Two levels of gaps must narrow uniqueness.
    let a = sigs(&[
        1, 99, 10, 2, 99, 20, 3, 99, 100, 4, 99, 10, 5, 99, 20, 6, 99, 200, 7,
    ]);
    let b = sigs(&[
        11, 99, 10, 12, 99, 20, 13, 99, 100, 14, 99, 10, 15, 99, 20, 16, 99, 200, 17,
    ]);
    assert_eq!(
        diff::unmatched(&a, &b),
        (vec![0, 3, 6, 9, 12, 15, 18], vec![0, 3, 6, 9, 12, 15, 18])
    );
}

#[test]
fn regression_clear_moved_across_back_producer_damages_reader_only() {
    let mut l = list();
    quad(&mut l, [8., 8., 8., 8.]);
    quad(&mut l, [64., 64., 8., 8.]);
    quad(&mut l, [64., 64., 8., 8.]);
    l.draws[1].flags |= DRAW_TO_BACK_BUFFER;
    l.draws[2].flags |= DRAW_GROUP_COMPOSITE;
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.screen_ops[1].before = 2;
    let (plan, stats) = p.plan(&l, &f, &opts());
    assert_eq!(partial(plan), vec![[64, 64, 8, 8]]);
    assert!(
        stats.changed_new > 0,
        "reader must observe the clear's changed input"
    );
}

#[test]
fn regression_clear_moved_across_target_draws_skips() {
    let mut l = list();
    for x in [8., 32., 64.] {
        quad(&mut l, [x, 8., 8., 8.]);
    }
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    op(&mut l, 1, ScreenOpKind::Clear, [0; 4]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.screen_ops[1].before = 2;
    assert_eq!(p.plan(&l, &f, &opts()).0, Plan::Skip);
}

#[test]
fn regression_mipmaps_moved_across_target_draws_skips() {
    let mut l = list();
    for x in [8., 32., 64.] {
        quad(&mut l, [x, 8., 8., 8.]);
    }
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    op(&mut l, 1, ScreenOpKind::Mipmaps, [0, 0, 128, 128]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    l.screen_ops[1].before = 2;
    assert_eq!(p.plan(&l, &f, &opts()).0, Plan::Skip);
}

#[test]
fn regression_region_overflow_merges_nearest_pairs() {
    let mut l = list();
    l.target.width = 512;
    l.target.height = 512;
    let rects = [
        [8, 8, 8, 8],
        [32, 8, 8, 8],
        [56, 8, 8, 8],
        [424, 8, 8, 8],
        [448, 8, 8, 8],
        [472, 8, 8, 8],
        [8, 448, 8, 8],
        [32, 448, 8, 8],
        [448, 448, 8, 8],
        [472, 448, 8, 8],
    ];
    for r in rects {
        quad(&mut l, r.map(|v| v as f32));
    }
    let f = Facts::default();
    let mut p = seed(&l, &f);
    for item in &mut l.items {
        item.modulate[0] = 0.5;
    }
    let (plan, stats) = p.plan(
        &l,
        &f,
        &PlanOptions {
            regions_max: 4,
            ..opts()
        },
    );
    let regions = partial(plan);
    assert_eq!(regions.len(), 4);
    assert_eq!(stats.region_count, 4);
    for r in rects {
        assert!(covers(&regions, r));
    }
    let area: i64 = regions.iter().map(|r| PxRect::xywh(*r).area()).sum();
    assert!(
        area < 2000,
        "merged area {area} should be far below the 211584 px bounding box"
    );
}

#[test]
fn regression_region_overflow_target_crossing_runs() {
    let mut l = list();
    let rects = [[8, 0, 8, 8], [0, 8, 24, 8], [8, 16, 8, 8]];
    for r in rects {
        quad(&mut l, r.map(|v| v as f32));
    }
    let f = Facts::default();
    let mut p = seed(&l, &f);
    for item in &mut l.items {
        item.modulate[0] = 0.5;
    }
    let (plan, _) = p.plan(
        &l,
        &f,
        &PlanOptions {
            regions_max: 2,
            ..opts()
        },
    );
    let Plan::Partial {
        regions,
        back_regions,
    } = plan
    else {
        panic!("expected Partial");
    };
    assert_eq!(regions, vec![[0, 0, 24, 24]]);
    assert!(back_regions.is_empty());
    for r in rects {
        assert!(covers(&regions, r));
    }
    let px = crate::fill::account_partial(
        &l,
        &crate::fill::FillOptions::default(),
        &regions,
        &back_regions,
    );
    // Each cleared pixel is counted once, even where the original runs crossed.
    assert_eq!(px[crate::fill::Class::Clear as usize], 576.);
}

#[test]
fn regression_region_overflow_back_crossing_runs() {
    let mut l = list();
    l.target.width = 256;
    l.target.height = 256;
    let rects = [[32, 8, 8, 24], [8, 32, 56, 8], [32, 40, 8, 24]];
    for flags in [DRAW_TO_BACK_BUFFER, DRAW_GROUP_COMPOSITE] {
        for r in rects {
            let d = quad(&mut l, r.map(|v| v as f32));
            l.draws[d].flags |= flags;
            l.items[d].modulate[3] = 0.5;
        }
    }
    op(&mut l, 0, ScreenOpKind::Clear, [0; 4]);
    let f = Facts::default();
    let mut p = seed(&l, &f);
    for item in &mut l.items[..3] {
        item.modulate[0] = 0.5;
    }
    let (plan, _) = p.plan(
        &l,
        &f,
        &PlanOptions {
            regions_max: 2,
            ..opts()
        },
    );
    let Plan::Partial {
        regions,
        back_regions,
    } = plan
    else {
        panic!("expected Partial");
    };
    assert_eq!(regions, vec![[8, 8, 56, 56]]);
    assert_eq!(back_regions, vec![[0, 0, 72, 72]]);
    let visits = back_regions
        .iter()
        .filter(|r| covers(&[**r], [34, 34, 1, 1]))
        .count();
    assert_eq!(visits, 1);
    assert_eq!(1. - 0.5f64.powi(visits as i32), 0.5);
}

#[test]
fn random_region_masks_are_disjoint_and_cover_marked_cells() {
    let mut state = 0x5eed_d15cu32;
    let mut next = || {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        state
    };
    // Include empty/full masks, varying densities and targets with clipped edge cells.
    for cell in [1, 8] {
        for sample in 0..256 {
            let width = 6 * cell - u32::from(sample % 2 == 0 && cell > 1);
            let height = 6 * cell - u32::from(sample % 3 == 0 && cell > 1);
            let mut mask = Mask::new(width, height, cell);
            let mut marked = Vec::new();
            for y in 0..6 {
                for x in 0..6 {
                    if (next() >> 16) % 8 < sample % 9 {
                        let r = [
                            (x * cell) as i32,
                            (y * cell) as i32,
                            cell.min(width - x * cell) as i32,
                            cell.min(height - y * cell) as i32,
                        ];
                        mask.add(PxRect::xywh(r));
                        marked.push(r);
                    }
                }
            }
            for max in 1..=8 {
                let regions = mask.regions(max);
                assert_disjoint(&regions);
                assert!(regions.len() <= max);
                for r in &regions {
                    assert!(r[2] > 0 && r[3] > 0);
                    assert!(r[0] >= 0 && r[1] >= 0);
                    assert!(r[0] + r[2] <= width as i32);
                    assert!(r[1] + r[3] <= height as i32);
                    assert_eq!(r[0] % cell as i32, 0);
                    assert_eq!(r[1] % cell as i32, 0);
                    assert!(r[0] + r[2] == width as i32 || (r[0] + r[2]) % cell as i32 == 0);
                    assert!(r[1] + r[3] == height as i32 || (r[1] + r[3]) % cell as i32 == 0);
                }
                for r in &marked {
                    assert!(
                        covers(&regions, *r),
                        "missing {r:?} with max={max}: {regions:?}"
                    );
                }
            }
        }
    }
}
