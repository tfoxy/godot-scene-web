//! GAP2-RX (fidelity gap #2, receiver-side) made a late-arm-adopted CanvasTexture's diffuse
//! resident even when no command, instance parameter or material named the canvas texture itself.
//! LAR8 (late-arm-registry design, fork F2) retired that shortcut: the capture adopts before the
//! draw's mirror tap, so the adopting draw names the canvas texture (`ct-adopt-named`, LAR1 and
//! LAR7). These tests pin the retirement: an adopted canvas texture that nothing names keeps its
//! diffuse non-resident, exactly like a created one (P3-CT's rule).

use super::*;
use crate::state::*;

fn adopted_canvas(id: Id, diffuse: Id) -> Texture {
    Texture {
        id,
        origin: Origin::Adopted,
        adopted_content: Some(AdoptedContent::Current),
        kind: TextureKind::Canvas,
        status: EntryStatus::Ok,
        reason: None,
        version: 1,
        hash: None,
        format: None,
        source_format: None,
        width: 0,
        height: 0,
        mipmaps: false,
        payload_bytes: 0,
        variants: Vec::new(),
        canvas: Some(CanvasTexture {
            diffuse: Some(diffuse),
            filter: Filter::Default,
            repeat: Repeat::Default,
        }),
    }
}

fn adopted_image(id: Id, hash: Hash) -> Texture {
    Texture {
        id,
        origin: Origin::Adopted,
        adopted_content: Some(AdoptedContent::Current),
        kind: TextureKind::Image,
        status: EntryStatus::Ok,
        reason: None,
        version: 1,
        hash: Some(hash),
        format: Some("RGBA8".into()),
        source_format: None,
        width: 16,
        height: 16,
        mipmaps: false,
        payload_bytes: 1024,
        variants: Vec::new(),
        canvas: None,
    }
}

#[test]
fn adopted_canvas_diffuse_needs_a_name() {
    use super::residency::Names;
    const CANVAS: Id = 10;
    const DIFFUSE: Id = 11;
    let mut state = ResolvedState::empty(6);
    state
        .textures
        .insert(CANVAS, adopted_canvas(CANVAS, DIFFUSE));
    state
        .textures
        .insert(DIFFUSE, adopted_image(DIFFUSE, Hash([0x42; 32])));
    // Nothing names the canvas texture: no item, no material, no command.
    let mut names = Names::default();
    let mut delta = TxDelta::default();
    delta.textures_upserted = vec![CANVAS, DIFFUSE];
    names.update(&state, &delta, true);
    assert!(
        !names.is_named(DIFFUSE),
        "LAR8: an adopted canvas texture that nothing names must not name its diffuse (GAP2-RX's shortcut is retired)"
    );
    // The diffuse is not in the every-named-texture set (a fresh applier's fetch list).
    assert!(!names.all().contains(&DIFFUSE));
    // And a later transaction that upserts the diffuse again still does not fetch it.
    let mut delta2 = TxDelta::default();
    delta2.textures_upserted = vec![CANVAS, DIFFUSE];
    names.update(&state, &delta2, false);
    assert!(!names.is_named(DIFFUSE));
    assert!(!names.all().contains(&DIFFUSE));
}

#[test]
fn created_canvas_diffuse_still_needs_a_name() {
    use super::residency::Names;
    const CANVAS: Id = 10;
    const DIFFUSE: Id = 11;
    let mut state = ResolvedState::empty(6);
    let mut canvas = adopted_canvas(CANVAS, DIFFUSE);
    canvas.origin = Origin::Created;
    canvas.adopted_content = None;
    state.textures.insert(CANVAS, canvas);
    state
        .textures
        .insert(DIFFUSE, adopted_image(DIFFUSE, Hash([0x42; 32])));
    let mut names = Names::default();
    let mut delta = TxDelta::default();
    delta.textures_upserted = vec![CANVAS, DIFFUSE];
    names.update(&state, &delta, true);
    assert!(
        !names.is_named(DIFFUSE),
        "a created canvas texture that nothing names must not name its diffuse (P3-CT's rule)"
    );
}

/// The route LAR8 relies on: the adopting draw names the adopted canvas texture, so P3-CT's rule
/// names its diffuse with no shortcut.
#[test]
fn adopted_canvas_named_by_a_command_names_its_diffuse() {
    use super::residency::Names;
    const ITEM: Id = 3;
    const CANVAS: Id = 10;
    const DIFFUSE: Id = 11;
    let mut state = ResolvedState::empty(6);
    state
        .textures
        .insert(CANVAS, adopted_canvas(CANVAS, DIFFUSE));
    state
        .textures
        .insert(DIFFUSE, adopted_image(DIFFUSE, Hash([0x42; 32])));
    state.items.insert(
        ITEM,
        Item {
            id: ITEM,
            origin: Origin::Adopted,
            parent: Some(Parent {
                kind: ParentKind::Canvas,
                id: 1,
            }),
            children: Vec::new(),
            visible: true,
            draw_index: 0,
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
            use_identity_transform: false,
            content_version: 1,
            xform: geom::IDENTITY,
            modulate: [1.0; 4],
            self_modulate: [1.0; 4],
            custom_rect_rect: [0.0; 4],
            commands: Commands {
                list: vec![Command::TextureRect {
                    tex: Some(CANVAS),
                    tile: false,
                    transpose: false,
                    rect: [0.0, 0.0, 16.0, 16.0],
                    modulate: [1.0; 4],
                }],
                ..Commands::default()
            },
        },
    );
    let mut names = Names::default();
    let mut delta = TxDelta::default();
    delta.items_upserted = vec![ITEM];
    delta.items_commands = vec![ITEM];
    delta.textures_upserted = vec![CANVAS, DIFFUSE];
    names.update(&state, &delta, true);
    assert!(names.is_named(CANVAS));
    assert!(
        names.is_named(DIFFUSE),
        "a named adopted canvas texture names its diffuse (P3-CT's rule)"
    );
    assert!(names.all().contains(&DIFFUSE));
}
