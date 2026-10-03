//! A patch that replaces the scene's resource list: the raster-text key swap a text change needs.
use godot_scene_web_rust_prototype::{
    contract::{Command, Patch, Scene, SceneState},
    geometry::{Geometry, ResourceIndexCache, build, patch_spans_renaming},
    resources::ResourceStore,
};
use serde_json::{Value, json};

fn rsr1(items: &[(&str, u32, u32)]) -> Vec<u8> {
    let mut v = b"RSR1".to_vec();
    v.extend((items.len() as u32).to_le_bytes());
    for (key, width, height) in items {
        let pixels = (width * height * 4) as usize;
        for n in [key.len() as u32, *width, *height, pixels as u32] {
            v.extend(n.to_le_bytes());
        }
        v.extend(key.as_bytes());
        v.extend(std::iter::repeat_n(255u8, pixels));
    }
    v
}
fn quad(id: &str, kind: &str, resource: &str, w: f32, x: f32) -> Value {
    json!({"id":id,"kind":kind,"resource":resource,"m":[1,0,0,1,x,0],"w":w,"h":8,"src":[0,0,w,8],
        "color":[1,1,1,1],"blend":"mix","flipH":false,"flipV":false,"colorMatrix":null})
}
fn scene(resources: &[(&str, u32, u32)], commands: Vec<Value>) -> Value {
    json!({"version":2,"revision":1,"width":64,"height":64,"designWidth":64,"designHeight":64,
        "resources": resources.iter().map(|(k, w, h)| json!({"key":k,"width":w,"height":h})).collect::<Vec<_>>(),
        "commands": commands})
}
fn admitted(value: &Value, store: &ResourceStore) -> SceneState {
    let mut state = SceneState::default();
    let admission = state.admit(&serde_json::to_vec(value).unwrap(), &store.ready());
    assert!(admission.accepted, "{admission:?}");
    state
}
fn patch(value: Value) -> Patch {
    serde_json::from_value(value).unwrap()
}
fn no_clips(_: usize) -> Option<[Option<usize>; 3]> {
    Some([None, None, None])
}
/// The committed geometry after applying a span patch the way the renderer does: spans written in place,
/// renamed slots renamed.
fn patched(
    old: &Geometry,
    state: &SceneState,
    delta_updates: &[(usize, Command)],
    resources: &[godot_scene_web_rust_prototype::contract::Resource],
) -> Option<Geometry> {
    let mut cache: ResourceIndexCache = None;
    let patch = patch_spans_renaming(
        old,
        state.scene().unwrap(),
        delta_updates,
        no_clips,
        &mut cache,
        0,
        Some(resources),
    )?;
    let mut next = old.clone();
    for (start, instances) in patch.spans {
        next.instances[start..start + instances.len()].copy_from_slice(&instances);
    }
    for rename in patch.renames {
        next.draws[rename.draw].resources[rename.slot] = Some(rename.key);
    }
    Some(next)
}
fn next_scene(
    state: &SceneState,
    delta_updates: &[(usize, Command)],
    resources: Vec<godot_scene_web_rust_prototype::contract::Resource>,
) -> Scene {
    let mut next = state.scene().unwrap().clone();
    for (index, command) in delta_updates {
        next.commands[*index] = command.clone();
    }
    next.resources = resources;
    next
}

#[test]
fn a_text_key_swap_preflights_commits_and_renames_one_slot_exactly() {
    let mut store = ResourceStore::default();
    store
        .upload_batch(&rsr1(&[("bg", 4, 4), ("t:04:00", 30, 8)]))
        .unwrap();
    let base = scene(
        &[("bg", 4, 4), ("t:04:00", 30, 8)],
        vec![
            quad("bg", "quad", "bg", 64.0, 0.0),
            quad("tclock", "rasterText", "t:04:00", 30.0, 10.0),
        ],
    );
    let mut state = admitted(&base, &store);
    let old = build(state.scene().unwrap());
    let swap = json!({"version":1,"baseRevision":1,"revision":2,
        "updates":[{"id":"tclock","command":quad("tclock","rasterText","t:04:01",28.0,11.0)}],
        "resources":[{"key":"bg","width":4,"height":4},{"key":"t:04:01","width":28,"height":8}]});
    // Not resident yet: refused, scene untouched.
    assert_eq!(
        state
            .preflight_delta(&patch(swap.clone()), &store, false)
            .unwrap_err(),
        "resources not ready"
    );
    assert_eq!(
        state
            .preflight_delta(&patch(swap.clone()), &store, true)
            .unwrap_err(),
        "resources not ready"
    );
    store.upload_batch(&rsr1(&[("t:04:01", 28, 8)])).unwrap();
    let delta = state.preflight_delta(&patch(swap), &store, false).unwrap();
    let resources = delta.resources.clone().unwrap();
    let geometry = patched(&old, &state, &delta.updates, &resources).expect("slot rename");
    let expected = build(&next_scene(&state, &delta.updates, resources));
    assert_eq!(geometry.draws, expected.draws);
    assert_eq!(geometry.instances, expected.instances);
    assert_eq!(geometry.command_ranges, expected.command_ranges);
    state.commit_delta(delta);
    let committed = state.scene().unwrap();
    assert_eq!(committed.revision, 2);
    assert_eq!(
        committed
            .resources
            .iter()
            .map(|r| r.key.as_str())
            .collect::<Vec<_>>(),
        ["bg", "t:04:01"]
    );
}

#[test]
fn a_resource_list_cannot_drop_a_key_still_drawn_or_resize_a_kept_one() {
    let mut store = ResourceStore::default();
    store
        .upload_batch(&rsr1(&[("a", 30, 8), ("b", 28, 8)]))
        .unwrap();
    let base = scene(
        &[("a", 30, 8)],
        vec![
            quad("t1", "rasterText", "a", 30.0, 0.0),
            quad("t2", "rasterText", "a", 30.0, 32.0),
        ],
    );
    let state = admitted(&base, &store);
    let drops_shared = json!({"version":1,"baseRevision":1,"revision":2,
        "updates":[{"id":"t1","command":quad("t1","rasterText","b",28.0,0.0)}],
        "resources":[{"key":"b","width":28,"height":8}]});
    assert_eq!(
        state
            .preflight_delta(&patch(drops_shared.clone()), &store, false)
            .unwrap_err(),
        "patch drops a resource still in use"
    );
    let mut general = SceneState::default();
    general.set_scene(state.scene().unwrap().clone());
    assert!(
        !general
            .patch(&serde_json::to_vec(&drops_shared).unwrap(), &store.ready())
            .accepted
    );
    assert_eq!(general.scene().unwrap().revision, 1);
    let resizes = json!({"version":1,"baseRevision":1,"revision":2,"updates":[],
        "resources":[{"key":"a","width":31,"height":8}]});
    assert_eq!(
        state
            .preflight_delta(&patch(resizes), &store, false)
            .unwrap_err(),
        "patch resizes a resource"
    );
    // Keeping the shared key is fine: both keys stay listed.
    let keeps = json!({"version":1,"baseRevision":1,"revision":2,
        "updates":[{"id":"t1","command":quad("t1","rasterText","b",28.0,0.0)}],
        "resources":[{"key":"a","width":30,"height":8},{"key":"b","width":28,"height":8}]});
    let delta = state
        .preflight_delta(&patch(keeps.clone()), &store, false)
        .unwrap();
    // …but the slot cannot simply be renamed: `a` is still drawn in that draw by t2.
    let old = build(state.scene().unwrap());
    assert!(
        patched(
            &old,
            &state,
            &delta.updates,
            delta.resources.as_ref().unwrap()
        )
        .is_none()
    );
    assert!(
        general
            .patch(&serde_json::to_vec(&keeps).unwrap(), &store.ready())
            .accepted
    );
    assert_eq!(general.scene().unwrap().resources.len(), 2);
}

#[test]
fn a_rename_refuses_when_a_fresh_build_would_lay_the_draws_out_differently() {
    // Eight distinct keys fill the first draw; the ninth opens the second.
    let keys: Vec<String> = (0..9).map(|i| format!("r{i}")).collect();
    let mut store = ResourceStore::default();
    let mut uploads: Vec<(&str, u32, u32)> = keys.iter().map(|k| (k.as_str(), 4, 8)).collect();
    uploads.push(("fresh", 4, 8));
    store.upload_batch(&rsr1(&uploads)).unwrap();
    let listed: Vec<(&str, u32, u32)> = keys.iter().map(|k| (k.as_str(), 4, 8)).collect();
    let commands = keys
        .iter()
        .enumerate()
        .map(|(i, k)| quad(&format!("q{i}"), "rasterText", k, 4.0, i as f32))
        .collect();
    let state = admitted(&scene(&listed, commands), &store);
    let old = build(state.scene().unwrap());
    assert_eq!(old.draws.len(), 2);
    let swap = |id: &str, from: &str, to: &str| {
        let mut list: Vec<Value> = keys
            .iter()
            .filter(|k| k.as_str() != from)
            .map(|k| json!({"key":k,"width":4,"height":8}))
            .collect();
        if !keys.iter().any(|k| k == to) {
            list.push(json!({"key":to,"width":4,"height":8}));
        }
        let index: usize = id[1..].parse().unwrap();
        json!({"version":1,"baseRevision":1,"revision":2,
            "updates":[{"id":id,"command":quad(id,"rasterText",to,4.0,index as f32)}],"resources":list})
    };
    // q3 r3 -> fresh: a plain rename, the same table a fresh build makes.
    let delta = state
        .preflight_delta(&patch(swap("q3", "r3", "fresh")), &store, false)
        .unwrap();
    let resources = delta.resources.clone().unwrap();
    let geometry = patched(&old, &state, &delta.updates, &resources).unwrap();
    let expected = build(&next_scene(&state, &delta.updates, resources));
    assert_eq!(
        (geometry.draws, geometry.instances),
        (expected.draws, expected.instances)
    );
    // q3 r3 -> r8: r8 opens the next draw, so a fresh build would pull q8 into the (full) first draw.
    let delta = state
        .preflight_delta(&patch(swap("q3", "r3", "r8")), &store, false)
        .unwrap();
    let resources = delta.resources.clone().unwrap();
    assert!(patched(&old, &state, &delta.updates, &resources).is_none());
    assert_ne!(
        build(&next_scene(&state, &delta.updates, resources)).draws,
        old.draws
    );
    // q8 r8 -> r2: r2 is already in the previous (full) draw, which a fresh build would join.
    let delta = state
        .preflight_delta(&patch(swap("q8", "r8", "r2")), &store, false)
        .unwrap();
    assert!(
        patched(
            &old,
            &state,
            &delta.updates,
            delta.resources.as_ref().unwrap()
        )
        .is_none()
    );
}

#[test]
fn a_glyph_run_with_the_same_glyph_count_patches_in_place_and_a_new_count_does_not() {
    let mut store = ResourceStore::default();
    let mut atlas = b"RSR2".to_vec();
    atlas.extend(1u32.to_le_bytes());
    atlas.extend([3, 1, 0, 0]); // allocate, linear
    for n in [5u32, 64, 64, 0, 0, 0, 0, 0] {
        atlas.extend(n.to_le_bytes());
    }
    atlas.extend(b"atlas");
    store.upload_batch(&atlas).unwrap();
    let run = |glyphs: &[[f32; 4]]| {
        json!({"id":"tclock","kind":"glyphRun","atlas":"atlas","m":[1,0,0,1,4,4],
        "glyphs": glyphs.iter().map(|src| json!({"src":src,"dst":[src[0],0,src[2],src[3]]})).collect::<Vec<_>>(),
        "method":"msdf","fill":[1,1,1,1],"outline":null,"shadow":{"color":[0,0,0,1],"offset":[1,1]},
        "pxRange":8,"alpha":1})
    };
    let base = scene(
        &[("atlas", 64, 64)],
        vec![run(&[[0.0, 0.0, 8.0, 8.0], [8.0, 0.0, 8.0, 8.0]])],
    );
    let state = admitted(&base, &store);
    let old = build(state.scene().unwrap());
    let next: Command =
        serde_json::from_value(run(&[[0.0, 0.0, 8.0, 8.0], [16.0, 0.0, 6.0, 8.0]])).unwrap();
    let updates = vec![(0usize, next)];
    let mut cache: ResourceIndexCache = None;
    let spans = patch_spans_renaming(
        &old,
        state.scene().unwrap(),
        &updates,
        no_clips,
        &mut cache,
        0,
        None,
    )
    .expect("same glyph count patches in place");
    assert!(spans.renames.is_empty());
    let mut geometry = old.clone();
    for (start, instances) in spans.spans {
        geometry.instances[start..start + instances.len()].copy_from_slice(&instances);
    }
    let expected = build(&next_scene(
        &state,
        &updates,
        state.scene().unwrap().resources.clone(),
    ));
    assert_eq!(
        (geometry.draws, geometry.instances),
        (expected.draws, expected.instances)
    );
    let longer: Command = serde_json::from_value(run(&[
        [0.0, 0.0, 8.0, 8.0],
        [8.0, 0.0, 8.0, 8.0],
        [16.0, 0.0, 8.0, 8.0],
    ]))
    .unwrap();
    assert!(
        patch_spans_renaming(
            &old,
            state.scene().unwrap(),
            &[(0, longer)],
            no_clips,
            &mut cache,
            0,
            None
        )
        .is_none()
    );
}

#[test]
fn a_patch_checks_only_the_keys_its_list_adds_unless_residency_moved() {
    use godot_scene_web_rust_prototype::contract::ReadyResources;
    // A lookup that knows only the added key: the committed list's keys were resident at admission.
    struct Only(&'static str, (u32, u32));
    impl ReadyResources for Only {
        fn ready_size(&self, key: &str) -> Option<(u32, u32)> {
            (key == self.0).then_some(self.1)
        }
    }
    let mut store = ResourceStore::default();
    store
        .upload_batch(&rsr1(&[("bg", 4, 4), ("t:04:00", 30, 8)]))
        .unwrap();
    let base = scene(
        &[("bg", 4, 4), ("t:04:00", 30, 8)],
        vec![
            quad("bg", "quad", "bg", 64.0, 0.0),
            quad("tclock", "rasterText", "t:04:00", 30.0, 10.0),
        ],
    );
    let state = admitted(&base, &store);
    let swap = patch(json!({"version":1,"baseRevision":1,"revision":2,
        "updates":[{"id":"tclock","command":quad("tclock","rasterText","t:04:01",28.0,11.0)}],
        "resources":[{"key":"bg","width":4,"height":4},{"key":"t:04:01","width":28,"height":8}]}));
    let ready = Only("t:04:01", (28, 8));
    assert!(state.preflight_delta(&swap, &ready, false).is_ok());
    assert_eq!(
        state.preflight_delta(&swap, &ready, true).unwrap_err(),
        "resources not ready"
    );
    assert_eq!(
        state
            .preflight_delta(&swap, &Only("t:04:01", (27, 8)), false)
            .unwrap_err(),
        "resources not ready"
    );
}

#[test]
fn the_resource_index_moves_to_a_new_epoch_in_place() {
    use godot_scene_web_rust_prototype::{contract::Resource, geometry::update_resource_index};
    let resource = |key: &str, width: u32| Resource {
        key: key.into(),
        width,
        height: 8,
    };
    let mut cache: ResourceIndexCache = Some((
        3,
        [("bg".to_string(), (4, 8)), ("t:04:00".to_string(), (30, 8))]
            .into_iter()
            .collect(),
    ));
    update_resource_index(
        &mut cache,
        3,
        4,
        &[resource("bg", 4), resource("t:04:01", 28)],
    );
    let (epoch, map) = cache.as_ref().unwrap();
    assert_eq!(*epoch, 4);
    assert_eq!(map.len(), 2);
    assert_eq!(map.get("t:04:01"), Some(&(28, 8)));
    assert!(!map.contains_key("t:04:00"));
    // A cache from another epoch is stale: left for the next lookup to rebuild.
    update_resource_index(&mut cache, 3, 5, &[resource("bg", 4)]);
    assert_eq!(cache.as_ref().unwrap().0, 4);
}
