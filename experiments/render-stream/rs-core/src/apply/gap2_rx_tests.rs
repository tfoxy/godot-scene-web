//! GAP2-RX (fidelity gap #2, receiver-side): a late-arm-adopted CanvasTexture's diffuse must be
//! resident on the receiver even when no command, instance parameter or material names the canvas
//! texture itself. P3-CT named the diffuse of a *named* canvas texture; a late-arm adoption can
//! land the canvas texture and its diffuse before (or instead of) the item's draw that would name
//! it, and the draw may have been recorded `unknown-texture` before the adoption. The diffuse is
//! then the only texture that must be fetched for the canvas texture to draw, so the adoption must
//! name it.

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
fn adopted_canvas_diffuse_is_named_without_a_command() {
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
        names.is_named(DIFFUSE),
        "an adopted canvas texture must name its diffuse even though no command names the canvas texture"
    );
    // The diffuse is part of the every-named-texture set (a fresh applier's fetch list).
    assert!(names.all().contains(&DIFFUSE));
    // And the next transaction's candidates still fetch it once its entry is upserted.
    let mut delta2 = TxDelta::default();
    delta2.textures_upserted = vec![DIFFUSE];
    names.update(&state, &delta2, false);
    assert!(names.take_changed().contains(&DIFFUSE));
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
        "a created canvas texture that nothing names must not name its diffuse (P3-CT's rule, unchanged)"
    );
}
