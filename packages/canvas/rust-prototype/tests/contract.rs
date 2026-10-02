use godot_scene_web_rust_prototype::{
    contract::SceneState, geometry::build, resources::ResourceStore,
};
use serde_json::json;
fn scene() -> serde_json::Value {
    json!({"version":2,"revision":1,"width":64,"height":64,"designWidth":64,"designHeight":64,"resources":[{"key":"red","width":1,"height":1}],"commands":[{"id":"clip","kind":"clipPush","rect":[0,0,64,64],"radius":8,"outset":0},{"id":"q","kind":"quad","resource":"red","m":[1,0,0,1,0,0],"w":64,"h":64,"src":[0,0,1,1],"color":[1,1,1,1],"blend":"mix","flipH":false,"flipV":false,"colorMatrix":null},{"id":"pop","kind":"clipPop"}]})
}
fn bundle(pixels: [u8; 4]) -> Vec<u8> {
    let mut v = b"RSR1".to_vec();
    for n in [1u32, 3, 1, 1, 4] {
        v.extend(n.to_le_bytes())
    }
    v.extend(b"red");
    v.extend(pixels);
    v
}
#[test]
fn resource_upload_is_transactional_and_reports_only_changes() {
    let mut r = ResourceStore::default();
    let initial_epoch = r.dimensions_epoch;
    assert_eq!(
        r.upload_batch(&bundle([255, 0, 0, 255]))
            .unwrap()
            .iter()
            .map(|v| v.key().to_string())
            .collect::<Vec<_>>(),
        vec!["red"]
    );
    assert_eq!(r.dimensions_epoch, initial_epoch + 1);
    assert!(
        r.upload_batch(&bundle([255, 0, 0, 255]))
            .unwrap()
            .is_empty()
    );
    let mut invalid = bundle([0, 0, 0, 0]);
    invalid.pop();
    assert!(r.upload_batch(&invalid).is_err());
    assert_eq!(r.entries["red"].width, 1);
    r.upload_batch(&bundle([0, 0, 0, 255])).unwrap();
    assert_eq!(r.dimensions_epoch, initial_epoch + 1);
}
#[test]
fn resource_preflight_and_unsupported_commands_refuse_without_replacing_scene() {
    let mut s = SceneState::default();
    let mut r = ResourceStore::default();
    let raw = serde_json::to_vec(&scene()).unwrap();
    assert_eq!(s.admit(&raw, &r.ready()).resource_pending, 1);
    assert!(s.scene().is_none());
    r.upload_batch(&bundle([255, 0, 0, 255])).unwrap();
    assert!(s.admit(&raw, &r.ready()).accepted);
    let mut bad = scene();
    bad["commands"][1]["kind"] = json!("texturedMesh");
    let result = s.admit(&serde_json::to_vec(&bad).unwrap(), &r.ready());
    assert_eq!(result.unsupported_commands, 1);
    assert_eq!(s.scene().unwrap().revision, 1);
}
#[test]
fn patches_reject_stale_or_shape_mismatch_atomically() {
    let mut s = SceneState::default();
    let mut r = ResourceStore::default();
    r.upload_batch(&bundle([255, 0, 0, 255])).unwrap();
    assert!(
        s.admit(&serde_json::to_vec(&scene()).unwrap(), &r.ready())
            .accepted
    );
    let mut changed = scene()["commands"][1].clone();
    changed["w"] = json!(32);
    let patch =
        json!({"version":1,"baseRevision":1,"revision":2,"updates":[{"id":"q","command":changed}]});
    assert!(
        s.patch(&serde_json::to_vec(&patch).unwrap(), &r.ready())
            .accepted
    );
    assert_eq!(s.scene().unwrap().revision, 2);
    let stale = s.patch(&serde_json::to_vec(&patch).unwrap(), &r.ready());
    assert!(!stale.accepted);
    let malformed = json!({"version":1,"baseRevision":2,"revision":3,"updates":[{"id":"q","command":{"id":"q","kind":"clipPop"}}]});
    assert!(
        !s.patch(&serde_json::to_vec(&malformed).unwrap(), &r.ready())
            .accepted
    );
    assert_eq!(s.scene().unwrap().revision, 2);
}
#[test]
fn nine_patch_expands_and_clip_geometry_carries_depth() {
    let mut value = scene();
    let mut nine = value["commands"][1].clone();
    nine["kind"] = json!("ninePatch");
    nine["margins"] = json!([1, 1, 1, 1]);
    nine["src"] = json!([0, 0, 3, 3]);
    value["resources"][0]["width"] = json!(3);
    value["resources"][0]["height"] = json!(3);
    value["commands"][1] = nine;
    let parsed = serde_json::from_value(value).unwrap();
    let g = build(&parsed);
    assert_eq!(g.instances.len(), 9);
    assert_eq!(g.draws.len(), 1);
    assert_eq!(g.instances[0].clip_params[0], [8.0, 0.0]);
}

#[test]
fn negative_nine_patch_source_refuses_full_and_patch_without_losing_scene() {
    let mut state = SceneState::default();
    let mut resources = ResourceStore::default();
    resources.upload_batch(&bundle([255, 0, 0, 255])).unwrap();
    let mut original = scene();
    original["commands"][1]["kind"] = json!("ninePatch");
    original["commands"][1]["margins"] = json!([0, 0, 0, 0]);
    assert!(
        state
            .admit(&serde_json::to_vec(&original).unwrap(), &resources.ready())
            .accepted
    );
    let mut bad_command = original["commands"][1].clone();
    bad_command["src"] = json!([0, 0, -1, 1]);
    let mut bad_scene = original.clone();
    bad_scene["revision"] = json!(2);
    bad_scene["commands"][1] = bad_command.clone();
    let admission = state.admit(&serde_json::to_vec(&bad_scene).unwrap(), &resources.ready());
    assert_eq!(admission.error.as_deref(), Some("invalid quad"));
    assert_eq!(state.scene().unwrap().revision, 1);
    let patch = json!({"version":1,"baseRevision":1,"revision":2,"updates":[{"id":"q","command":bad_command}]});
    let patched = state.patch(&serde_json::to_vec(&patch).unwrap(), &resources.ready());
    assert_eq!(patched.error.as_deref(), Some("invalid quad"));
    let parsed = serde_json::from_value(patch).unwrap();
    assert_eq!(
        state
            .preflight_patch(&parsed, Some(&resources.ready()))
            .unwrap_err(),
        "invalid quad"
    );
    assert_eq!(state.scene().unwrap().revision, 1);
}

#[test]
fn full_scene_admission_refuses_equal_and_older_revisions() {
    let mut state = SceneState::default();
    let mut resources = ResourceStore::default();
    resources.upload_batch(&bundle([255, 0, 0, 255])).unwrap();
    let first = scene();
    assert!(
        state
            .admit(&serde_json::to_vec(&first).unwrap(), &resources.ready())
            .accepted
    );
    assert!(
        !state
            .admit(&serde_json::to_vec(&first).unwrap(), &resources.ready())
            .accepted
    );
    let mut newer = first.clone();
    newer["revision"] = json!(2);
    assert!(
        state
            .admit(&serde_json::to_vec(&newer).unwrap(), &resources.ready())
            .accepted
    );
    assert!(
        !state
            .admit(&serde_json::to_vec(&first).unwrap(), &resources.ready())
            .accepted
    );
    assert_eq!(state.scene().unwrap().revision, 2);
}

#[test]
fn ordered_eight_slot_batches_and_dirty_instance_ranges() {
    use godot_scene_web_rust_prototype::geometry::{dirty_ranges, same_layout};
    let mut value = scene();
    value["resources"] = json!(
        (0..10)
            .map(|i| json!({"key":format!("r{i}"),"width":1,"height":1}))
            .collect::<Vec<_>>()
    );
    let template = value["commands"][1].clone();
    let mut commands = Vec::new();
    for i in 0..10 {
        let mut command = template.clone();
        command["id"] = json!(format!("q{i}"));
        command["resource"] = json!(format!("r{i}"));
        commands.push(command);
    }
    value["commands"] = json!(commands);
    let old = build(&serde_json::from_value(value.clone()).unwrap());
    assert_eq!(old.instances.len(), 10);
    assert_eq!(old.draws.len(), 2);
    assert_eq!(old.draws[0].resources.len(), 8);
    assert_eq!(old.draws[1].resources.len(), 2);
    value["commands"][4]["color"] = json!([0.5, 1, 1, 1]);
    let changed = build(&serde_json::from_value(value.clone()).unwrap());
    assert!(same_layout(&old, &changed));
    assert_eq!(
        dirty_ranges(&old.instances, &changed.instances),
        vec![(4, 5)]
    );
    value["commands"][4]["blend"] = json!("add");
    let changed_blend = build(&serde_json::from_value(value).unwrap());
    assert!(!same_layout(&old, &changed_blend));
}

#[test]
fn patch_instances_reuses_layout_and_falls_back_for_shape_changes() {
    use godot_scene_web_rust_prototype::geometry::patch_instances;
    let old_scene = serde_json::from_value(scene()).unwrap();
    let old = build(&old_scene);
    let mut changed = scene();
    changed["commands"][1]["src"] = json!([0.25, 0.0, 0.5, 1.0]);
    changed["commands"][1]["flipH"] = json!(true);
    changed["commands"][1]["color"] = json!([0.5, 1.0, 1.0, 1.0]);
    let next_scene = serde_json::from_value(changed.clone()).unwrap();
    let patched = patch_instances(&old, &old_scene, &next_scene, &["q".into()]).unwrap();
    assert_eq!(patched.draws, old.draws);
    assert_eq!(patched.command_ranges, old.command_ranges);
    assert_eq!(patched.instances[0].clip_params[0], [8.0, 0.0]);
    assert_ne!(patched.instances[0], old.instances[0]);
    changed["commands"][1]["blend"] = json!("add");
    let changed_blend = serde_json::from_value(changed.clone()).unwrap();
    assert!(patch_instances(&old, &old_scene, &changed_blend, &["q".into()]).is_none());
    changed["commands"][0]["radius"] = json!(3.0);
    let changed_clip = serde_json::from_value(changed).unwrap();
    assert!(patch_instances(&old, &old_scene, &changed_clip, &["clip".into()]).is_none());
}

#[test]
fn preflight_and_span_patch_preserve_committed_scene_until_commit() {
    use godot_scene_web_rust_prototype::{contract::Patch, geometry::patch_spans};
    let mut state = SceneState::default();
    let mut resources = ResourceStore::default();
    resources.upload_batch(&bundle([255, 0, 0, 255])).unwrap();
    assert!(
        state
            .admit(&serde_json::to_vec(&scene()).unwrap(), &resources.ready())
            .accepted
    );
    let before = build(state.scene().unwrap());
    let mut changed = scene()["commands"][1].clone();
    changed["m"] = json!([1, 0, 0, 1, 12, 14]);
    let patch: Patch = serde_json::from_value(
        json!({"version":1,"baseRevision":1,"revision":2,"updates":[{"id":"q","command":changed}]}),
    )
    .unwrap();
    let ready = resources.ready();
    let updates = state.preflight_patch(&patch, Some(&ready)).unwrap();
    let spans = patch_spans(&before, state.scene().unwrap(), &updates, |i| {
        state.clips_at(i).copied()
    })
    .unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].0, 0);
    assert_eq!(spans[0].1[0].clips[0], [0.0, 0.0, 64.0, 64.0]);
    assert_eq!(state.scene().unwrap().revision, 1);
    assert_eq!(before.instances[0].origin_axis_x[0], 0.0);
    let mut bad = patch;
    bad.updates[0].command = serde_json::from_value(json!({"id":"q","kind":"clipPop"})).unwrap();
    assert!(state.preflight_patch(&bad, Some(&ready)).is_err());
    assert_eq!(state.scene().unwrap().revision, 1);
    state.commit_updates(2, updates);
    assert_eq!(state.scene().unwrap().revision, 2);
}

#[test]
fn oversized_resource_batch_refuses_without_partial_admission() {
    let mut resources = ResourceStore::with_max_side(1);
    let mut batch = b"RSR1".to_vec();
    batch.extend(2u32.to_le_bytes());
    for (key, width, pixels) in [
        (b"a".as_slice(), 1u32, vec![1u8; 4]),
        (b"b".as_slice(), 2u32, vec![2u8; 8]),
    ] {
        for n in [key.len() as u32, width, 1, pixels.len() as u32] {
            batch.extend(n.to_le_bytes());
        }
        batch.extend(key);
        batch.extend(pixels);
    }
    assert!(resources.upload_batch(&batch).is_err());
    assert!(resources.entries.is_empty());
}

#[test]
fn scene_v2_requires_nonzero_design_dimensions() {
    let mut state = SceneState::default();
    let ready = std::collections::HashMap::new();
    let mut value = scene();
    value["version"] = json!(1);
    let old = state.admit(&serde_json::to_vec(&value).unwrap(), &ready);
    assert_eq!(old.error.as_deref(), Some("invalid scene header"));
    value["version"] = json!(2);
    value["designWidth"] = json!(0);
    let zero = state.admit(&serde_json::to_vec(&value).unwrap(), &ready);
    assert_eq!(zero.error.as_deref(), Some("invalid scene header"));
}

/// Nested clips: `outer` holds q1, `inner` (holding q2) and a nine-patch q3; q4 is outside both.
fn clipped_scene() -> serde_json::Value {
    let quad = |id: &str, x: f32| {
        let mut command = scene()["commands"][1].clone();
        command["id"] = json!(id);
        command["m"] = json!([1, 0, 0, 1, x, 4]);
        command["w"] = json!(8);
        command["h"] = json!(8);
        command
    };
    let mut nine = quad("q3", 30.0);
    nine["kind"] = json!("ninePatch");
    nine["margins"] = json!([0.25, 0.25, 0.25, 0.25]);
    let mut value = scene();
    value["commands"] = json!([
        {"id":"outer","kind":"clipPush","rect":[0,0,40,40],"radius":4,"outset":1},
        quad("q1", 2.0),
        {"id":"inner","kind":"clipPush","rect":[10,10,20,20],"radius":0,"outset":0},
        quad("q2", 12.0),
        {"id":"innerPop","kind":"clipPop"},
        nine,
        {"id":"outerPop","kind":"clipPop"},
        quad("q4", 50.0)
    ]);
    value
}

#[test]
fn clip_replacement_patches_scope_instances_in_place() {
    use godot_scene_web_rust_prototype::{
        contract::Patch,
        geometry::{patch_spans, same_layout},
    };
    let mut state = SceneState::default();
    let mut resources = ResourceStore::default();
    resources.upload_batch(&bundle([255, 0, 0, 255])).unwrap();
    let value = clipped_scene();
    assert!(state.admit(&serde_json::to_vec(&value).unwrap(), &resources.ready()).accepted);
    let before = build(state.scene().unwrap());
    let mut q1 = value["commands"][1].clone();
    q1["m"] = json!([1, 0, 0, 1, 7, 1]);
    let patch: Patch = serde_json::from_value(json!({"version":1,"baseRevision":1,"revision":2,"updates":[
        {"id":"outer","command":{"id":"outer","kind":"clipPush","rect":[5,-3,40,40],"radius":4,"outset":1}},
        {"id":"inner","command":{"id":"inner","kind":"clipPush","rect":[12,12,20,20],"radius":0,"outset":0}},
        {"id":"q1","command":q1}
    ]}))
    .unwrap();
    let ready = resources.ready();
    let updates = state.preflight_patch(&patch, Some(&ready)).unwrap();
    let spans = patch_spans(&before, state.scene().unwrap(), &updates, |i| state.clips_at(i).copied()).unwrap();
    let mut patched = before.clone();
    for (start, instances) in &spans {
        patched.instances[*start..*start + instances.len()].copy_from_slice(instances);
    }
    // Exactly what a full rebuild of the patched scene produces, on the same draw table.
    let mut next = value.clone();
    next["revision"] = json!(2);
    next["commands"][0]["rect"] = json!([5, -3, 40, 40]);
    next["commands"][2]["rect"] = json!([12, 12, 20, 20]);
    next["commands"][1] = q1;
    let expected = build(&serde_json::from_value(next).unwrap());
    assert!(same_layout(&before, &expected));
    assert_eq!(patched.instances, expected.instances);
    assert_eq!(patched.instances[0].clips[0], [5.0, -3.0, 40.0, 40.0]);
    assert_eq!(patched.instances[1].clips[1], [12.0, 12.0, 20.0, 20.0]);
    // Only the clips' scopes were touched: q4 (the last instance, outside both) has no span.
    let q4 = before.command_ranges[7].0 as usize;
    assert!(spans.iter().all(|(start, instances)| q4 < *start || q4 >= start + instances.len()));
    assert_eq!(patched.instances[q4], before.instances[q4]);
    // The committed scene changes only at commit, and its clip index stays valid.
    assert_eq!(state.scene().unwrap().revision, 1);
    state.commit_updates(2, updates);
    assert_eq!(state.clips_at(3).copied(), Some([Some(0), Some(2), None]));
    assert_eq!(build(state.scene().unwrap()).instances, expected.instances);
}

#[test]
fn clip_replacement_spans_refuse_shape_changes() {
    use godot_scene_web_rust_prototype::{contract::Command, geometry::patch_spans};
    let mut state = SceneState::default();
    let mut resources = ResourceStore::default();
    resources.upload_batch(&bundle([255, 0, 0, 255])).unwrap();
    assert!(state.admit(&serde_json::to_vec(&clipped_scene()).unwrap(), &resources.ready()).accepted);
    let before = build(state.scene().unwrap());
    let clips = |i: usize| state.clips_at(i).copied();
    // A clip replacement aimed at a quad's slot is a shape change: no span patch.
    let clip: Command = serde_json::from_value(
        json!({"id":"q1","kind":"clipPush","rect":[0,0,1,1],"radius":0,"outset":0}),
    )
    .unwrap();
    assert!(patch_spans(&before, state.scene().unwrap(), &[(1, clip)], clips).is_none());
    // A pop carries nothing a span could express.
    let pop: Command = serde_json::from_value(json!({"id":"innerPop","kind":"clipPop"})).unwrap();
    assert!(patch_spans(&before, state.scene().unwrap(), &[(4, pop)], clips).is_none());
}

fn rsr2(ops: &[(u8, u8, &str, u32, u32, u32, u32, u32, u32, Vec<u8>)]) -> Vec<u8> {
    let mut bytes = b"RSR2".to_vec();
    bytes.extend((ops.len() as u32).to_le_bytes());
    for (op, format, key, w, h, x, y, rw, rh, pixels) in ops {
        bytes.extend([*op, *format, 0, 0]);
        for n in [
            key.len() as u32,
            *w,
            *h,
            *x,
            *y,
            *rw,
            *rh,
            pixels.len() as u32,
        ] {
            bytes.extend(n.to_le_bytes());
        }
        bytes.extend(key.as_bytes());
        bytes.extend(pixels);
    }
    bytes
}
#[test]
fn rsr2_linear_subrect_and_release_are_transactional() {
    use godot_scene_web_rust_prototype::resources::{ResourceChange, ResourceFormat};
    let mut store = ResourceStore::default();
    let replace = rsr2(&[(0, 1, "atlas", 2, 2, 0, 0, 2, 2, vec![128; 16])]);
    let change = store.upload_batch(&replace).unwrap();
    assert_eq!(change.len(), 1);
    assert!(matches!(
        &change[0],
        ResourceChange::Replace {
            format: ResourceFormat::Linear,
            ..
        }
    ));
    assert_eq!(store.entries["atlas"].format, ResourceFormat::Linear);
    assert_eq!(store.ready()["atlas"], (2, 2));
    let epoch = store.dimensions_epoch;
    let subrect = rsr2(&[(1, 1, "atlas", 2, 2, 1, 0, 1, 1, vec![0, 0, 0, 255])]);
    assert!(matches!(
        &store.upload_batch(&subrect).unwrap()[0],
        ResourceChange::Subrect { x: 1, y: 0, .. }
    ));
    assert_eq!(store.dimensions_epoch, epoch);
    let invalid = rsr2(&[(1, 1, "atlas", 2, 2, 2, 0, 1, 1, vec![0; 4])]);
    assert!(store.upload_batch(&invalid).is_err());
    assert_eq!(store.ready()["atlas"], (2, 2));
    let release = rsr2(&[(2, 0, "atlas", 0, 0, 0, 0, 0, 0, vec![])]);
    assert!(matches!(
        &store.upload_batch(&release).unwrap()[0],
        ResourceChange::Release { .. }
    ));
    assert!(store.entries.is_empty());
}
#[test]
fn rsr2_allocate_is_zero_payload_fresh_and_transactional() {
    use godot_scene_web_rust_prototype::resources::{ResourceChange, ResourceFormat};
    let mut store = ResourceStore::with_max_side(1024);
    let allocate = rsr2(&[(3, 1, "atlas:g1", 1024, 1024, 0, 0, 0, 0, vec![])]);
    let plan = store.plan_batch(&allocate).unwrap();
    assert!(store.entries.is_empty());
    assert_eq!(store.dimensions_epoch, 0);
    assert_eq!(plan.changes[0].byte_len(), 0);
    assert!(matches!(
        plan.changes[0],
        ResourceChange::Allocate {
            format: ResourceFormat::Linear,
            ..
        }
    ));
    store.commit_batch(plan);
    assert_eq!(store.ready()["atlas:g1"], (1024, 1024));
    assert!(store.upload_batch(&allocate).is_err());
    let malformed = rsr2(&[(3, 1, "atlas:g2", 2, 2, 0, 0, 0, 0, vec![0])]);
    assert!(store.upload_batch(&malformed).is_err());
    let oversized = rsr2(&[(3, 1, "atlas:g2", 1025, 2, 0, 0, 0, 0, vec![])]);
    assert!(store.upload_batch(&oversized).is_err());
    let mixed = rsr2(&[
        (3, 1, "atlas:g2", 2, 2, 0, 0, 0, 0, vec![]),
        (1, 1, "atlas:g2", 2, 2, 2, 0, 1, 1, vec![255; 4]),
    ]);
    assert!(store.upload_batch(&mixed).is_err());
    assert!(!store.entries.contains_key("atlas:g2"));
    let good = rsr2(&[
        (3, 1, "atlas:g2", 2, 2, 0, 0, 0, 0, vec![]),
        (1, 1, "atlas:g2", 2, 2, 0, 0, 1, 1, vec![255; 4]),
    ]);
    assert_eq!(store.upload_batch(&good).unwrap().len(), 2);
    assert_eq!(store.ready()["atlas:g2"], (2, 2));
    let release = rsr2(&[(2, 0, "atlas:g2", 0, 0, 0, 0, 0, 0, vec![])]);
    assert_eq!(store.upload_batch(&release).unwrap().len(), 1);
    assert!(!store.entries.contains_key("atlas:g2"));
}
#[test]
fn resource_batch_stages_repeated_keys_without_changing_untouched_entries() {
    use godot_scene_web_rust_prototype::resources::ResourceChange;
    let mut store = ResourceStore::default();
    store
        .upload_batch(&rsr2(&[
            (0, 1, "untouched", 1, 1, 0, 0, 1, 1, vec![7; 4]),
            (0, 1, "atlas", 1, 1, 0, 0, 1, 1, vec![8; 4]),
        ]))
        .unwrap();
    let untouched = store.entries["untouched"].clone();
    let atlas = store.entries["atlas"].clone();
    let epoch = store.dimensions_epoch;
    let invalid = rsr2(&[
        (0, 1, "atlas", 2, 2, 0, 0, 2, 2, vec![9; 16]),
        (1, 1, "atlas", 2, 2, 2, 0, 1, 1, vec![0; 4]),
    ]);
    assert!(store.upload_batch(&invalid).is_err());
    assert_eq!(store.entries["atlas"], atlas);
    assert_eq!(store.entries["untouched"], untouched);
    assert_eq!(store.dimensions_epoch, epoch);
    let changes = store
        .upload_batch(&rsr2(&[
            (2, 0, "atlas", 0, 0, 0, 0, 0, 0, vec![]),
            (0, 1, "atlas", 2, 2, 0, 0, 2, 2, vec![9; 16]),
            (1, 1, "atlas", 2, 2, 1, 1, 1, 1, vec![0; 4]),
        ]))
        .unwrap();
    assert!(matches!(changes[0], ResourceChange::Release { .. }));
    assert!(matches!(changes[1], ResourceChange::Replace { .. }));
    assert!(matches!(changes[2], ResourceChange::Subrect { .. }));
    assert_eq!(store.ready()["atlas"], (2, 2));
    assert_eq!(store.entries["untouched"], untouched);
    assert_eq!(store.dimensions_epoch, epoch + 2);
}
#[test]
fn glyph_run_expands_shadow_before_fill_and_rejects_bad_tiles() {
    let scene = json!({ "version":2,"revision":1,"width":64,"height":64,"designWidth":64,"designHeight":64,
      "resources":[{"key":"atlas","width":48,"height":48}],
      "commands":[{"id":"g","kind":"glyphRun","atlas":"atlas","m":[1,0,0,1,0,0],
        "glyphs":[{"src":[0,0,24,24],"dst":[4,5,24,24]},
                  {"src":[24,0,24,24],"dst":[20,5,24,24]}],"method":"msdf",
        "fill":[1,0,0,1],"outline":{"color":[0,0,0,1],"width":2},
        "shadow":{"color":[0,0,0,0.5],"offset":[1,2]},"pxRange":4,"alpha":1}] });
    let parsed = serde_json::from_value(scene.clone()).unwrap();
    let geometry = build(&parsed);
    assert_eq!(geometry.instances.len(), 4);
    assert_eq!(geometry.command_ranges, vec![(0, 4)]);
    assert_eq!(geometry.instances[0].uv_size_slot[3], 1.0);
    assert_eq!(geometry.instances[1].uv_size_slot[3], 1.0);
    assert_eq!(geometry.instances[0].origin_axis_x[0..2], [5.0, 7.0]);
    assert_eq!(geometry.instances[1].origin_axis_x[0..2], [21.0, 7.0]);
    assert_eq!(geometry.instances[2].origin_axis_x[0..2], [4.0, 5.0]);
    assert_eq!(geometry.instances[2].matrix[0], 4.0);
    assert!(geometry.instances[2].matrix[3] > 0.0);
    let mut store = ResourceStore::default();
    store
        .upload_batch(&rsr2(&[(
            0,
            1,
            "atlas",
            48,
            48,
            0,
            0,
            48,
            48,
            vec![0; 48 * 48 * 4],
        )]))
        .unwrap();
    let mut state = SceneState::default();
    assert!(
        state
            .admit(&serde_json::to_vec(&scene).unwrap(), &store.ready())
            .accepted
    );
    let mut bad = scene;
    bad["revision"] = json!(2);
    bad["commands"][0]["glyphs"][0]["src"][2] = json!(-1);
    assert!(
        !state
            .admit(&serde_json::to_vec(&bad).unwrap(), &store.ready())
            .accepted
    );
}
#[test]
fn glyph_tiles_must_fit_declared_atlas_in_full_and_patch_admission() {
    let scene = json!({ "version":2,"revision":1,"width":64,"height":64,"designWidth":64,"designHeight":64,
      "resources":[{"key":"atlas","width":48,"height":48}],
      "commands":[{"id":"g","kind":"glyphRun","atlas":"atlas","m":[1,0,0,1,0,0],
        "glyphs":[{"src":[0,0,24,24],"dst":[4,5,24,24]}],"method":"msdf",
        "fill":[1,0,0,1],"pxRange":4,"alpha":1}] });
    let ready = std::collections::HashMap::from([("atlas".to_string(), (48, 48))]);
    let mut state = SceneState::default();
    assert!(
        state
            .admit(&serde_json::to_vec(&scene).unwrap(), &ready)
            .accepted
    );
    for src in [
        json!([-1, 0, 24, 24]),
        json!([0, -1, 24, 24]),
        json!([25, 0, 24, 24]),
        json!([0, 25, 24, 24]),
    ] {
        let mut bad = scene.clone();
        bad["revision"] = json!(2);
        bad["commands"][0]["glyphs"][0]["src"] = src;
        assert!(
            !state
                .admit(&serde_json::to_vec(&bad).unwrap(), &ready)
                .accepted
        );
        let patch = json!({"version":1,"baseRevision":1,"revision":2,
            "updates":[{"id":"g","command":bad["commands"][0]}]});
        assert!(
            !state
                .patch(&serde_json::to_vec(&patch).unwrap(), &ready)
                .accepted
        );
        assert_eq!(state.scene().unwrap().revision, 1);
    }
}

#[test]
fn clip_replacement_rewrites_glyph_instances_in_its_scope() {
    use godot_scene_web_rust_prototype::{contract::Patch, geometry::{patch_spans, same_layout}};
    // A glyph run (two glyphs, a shadow each: four instances) inside a clip that a patch translates.
    let scene = json!({ "version":2,"revision":1,"width":64,"height":64,"designWidth":64,"designHeight":64,
      "resources":[{"key":"atlas","width":48,"height":48}],
      "commands":[{"id":"clip","kind":"clipPush","rect":[0,0,40,40],"radius":2,"outset":0},
        {"id":"g","kind":"glyphRun","atlas":"atlas","m":[1,0,0,1,0,0],
        "glyphs":[{"src":[0,0,24,24],"dst":[4,5,24,24]},{"src":[24,0,24,24],"dst":[20,5,24,24]}],"method":"msdf",
        "fill":[1,0,0,1],"shadow":{"color":[0,0,0,0.5],"offset":[1,2]},"pxRange":4,"alpha":1},
        {"id":"pop","kind":"clipPop"}] });
    let ready = std::collections::HashMap::from([("atlas".to_string(), (48, 48))]);
    let mut state = SceneState::default();
    assert!(state.admit(&serde_json::to_vec(&scene).unwrap(), &ready).accepted);
    let before = build(state.scene().unwrap());
    let patch: Patch = serde_json::from_value(json!({"version":1,"baseRevision":1,"revision":2,"updates":[
        {"id":"clip","command":{"id":"clip","kind":"clipPush","rect":[6,-2,40,40],"radius":2,"outset":0}}]}))
    .unwrap();
    let updates = state.preflight_patch(&patch, Some(&ready)).unwrap();
    let spans = patch_spans(&before, state.scene().unwrap(), &updates, |i| state.clips_at(i).copied()).unwrap();
    let mut patched = before.clone();
    for (start, instances) in &spans {
        patched.instances[*start..*start + instances.len()].copy_from_slice(instances);
    }
    let mut next = scene.clone();
    next["commands"][0]["rect"] = json!([6, -2, 40, 40]);
    let expected = build(&serde_json::from_value(next).unwrap());
    assert!(same_layout(&before, &expected));
    assert_eq!(patched.instances.len(), 4);
    assert_eq!(patched.instances, expected.instances);
    assert!(patched.instances.iter().all(|instance| instance.clips[0] == [6.0, -2.0, 40.0, 40.0]));
}
