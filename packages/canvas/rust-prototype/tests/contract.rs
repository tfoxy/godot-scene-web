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
        r.upload_batch(&bundle([255, 0, 0, 255])).unwrap(),
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
    assert_eq!(r.pixels["red"].2, [255, 0, 0, 255]);
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
    assert!(state.admit(&serde_json::to_vec(&original).unwrap(), &resources.ready()).accepted);
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
    assert_eq!(state.preflight_patch(&parsed, Some(&resources.ready())).unwrap_err(), "invalid quad");
    assert_eq!(state.scene().unwrap().revision, 1);
}

#[test]
fn full_scene_admission_refuses_equal_and_older_revisions() {
    let mut state = SceneState::default();
    let mut resources = ResourceStore::default();
    resources.upload_batch(&bundle([255, 0, 0, 255])).unwrap();
    let first = scene();
    assert!(state.admit(&serde_json::to_vec(&first).unwrap(), &resources.ready()).accepted);
    assert!(!state.admit(&serde_json::to_vec(&first).unwrap(), &resources.ready()).accepted);
    let mut newer = first.clone();
    newer["revision"] = json!(2);
    assert!(state.admit(&serde_json::to_vec(&newer).unwrap(), &resources.ready()).accepted);
    assert!(!state.admit(&serde_json::to_vec(&first).unwrap(), &resources.ready()).accepted);
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
    assert!(resources.pixels.is_empty());
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
