//! A live client's deferred payloads (`Applier::defer`): the transaction applies without them,
//! what draws them is skipped (never drawn from the entry's older payload), and once they reach
//! the store a revisit (no transaction) or the next transaction's apply draws them. The oracle
//! is a fresh applier that had every payload from the start.

use super::override_tests::{applier, full_delta, full_delta_tex, mesh_scene, tex_scene, C1, C2};
use super::*;
use crate::state::*;

fn oracle(s: &ResolvedState, d: &TxDelta, store: &PayloadStore) -> (Hash, usize) {
    let mut a = applier();
    a.apply(s, d, store);
    (a.paint_digest(), a.list.draws.len())
}

fn pixels(seed: u8) -> payloads::TexturePixels {
    payloads::TexturePixels {
        width: 8,
        height: 8,
        rgba: vec![seed; 256].into(),
        format: "RGBA8".into(),
        mipmaps: false,
        data_len: 256,
        compressed: None,
        half: None,
        floats: None,
        opacity: None,
    }
}

#[test]
fn a_deferred_texture_is_not_drawn_then_a_revisit_draws_it() {
    let (s, full, h) = tex_scene();
    let d = full_delta_tex(&s);
    let (want, want_draws) = oracle(&s, &d, &full);
    let empty = PayloadStore::default();
    let mut b = applier();
    b.prepare(&s, &d);
    let mut needed = Vec::new();
    b.needed(&s, &d, &empty, &mut needed);
    assert_eq!(needed, vec![h], "the texture's payload is the needed set");
    b.defer(h);
    b.apply(&s, &d, &empty);
    assert!(b.is_deferred(&h));
    assert_eq!(
        b.list.draws.len(),
        want_draws - 1,
        "the item drawing the texture was drawn"
    );
    assert!(
        !b.referenced_payload_hashes().contains(&h),
        "the deferred texture is resident"
    );
    // Nothing arrived: no revisit.
    assert!(!b.revisit(&s, &empty));
    // The payload arrives with no transaction: the revisit draws what the oracle draws.
    assert!(
        b.revisit(&s, &full),
        "the arrived payload was not revisited"
    );
    assert!(!b.is_deferred(&h) && b.deferred_len() == 0);
    assert_eq!(
        b.paint_digest(),
        want,
        "the revisit does not draw the state"
    );
    assert!(
        !b.revisit(&s, &full),
        "a second revisit had something to do"
    );
}

#[test]
fn a_deferred_update_does_not_draw_the_older_payload() {
    let (mut s, mut store, a_hash) = tex_scene();
    let mut b = applier();
    b.apply(&s, &full_delta_tex(&s), &store);
    let shown = b.list.draws.len();
    // The host updates texture 5 to a payload still in flight.
    let b_hash = Hash([8; 32]);
    let t = s.textures.get_mut(&5).unwrap();
    t.hash = Some(b_hash);
    t.version = 2;
    let d = TxDelta {
        seq: 2,
        textures_upserted: vec![5],
        ..TxDelta::default()
    };
    b.prepare(&s, &d);
    let mut needed = Vec::new();
    b.needed(&s, &d, &store, &mut needed);
    assert_eq!(needed, vec![b_hash]);
    b.defer(b_hash);
    b.apply(&s, &d, &store);
    assert_eq!(
        b.list.draws.len(),
        shown - 1,
        "the older payload was drawn in its place"
    );
    assert!(
        !b.referenced_payload_hashes().contains(&a_hash),
        "the older payload stayed resident"
    );
    store.textures.insert(b_hash, pixels(40));
    assert!(b.revisit(&s, &store));
    let mut only_b = PayloadStore::default();
    only_b.textures.insert(b_hash, pixels(40));
    let (want, _) = oracle(&s, &full_delta_tex(&s), &only_b);
    assert_eq!(
        b.paint_digest(),
        want,
        "the revisit does not draw the updated texture"
    );
}

#[test]
fn a_deferred_mesh_is_not_drawn_then_a_revisit_draws_it() {
    let (s, full, h) = mesh_scene();
    let d = full_delta(&s);
    let (want, want_draws) = oracle(&s, &d, &full);
    let empty = PayloadStore::default();
    let mut b = applier();
    b.defer(h);
    b.apply(&s, &d, &empty);
    assert_eq!(
        b.list.draws.len(),
        want_draws - 1,
        "the item drawing the mesh was drawn"
    );
    assert!(b.revisit(&s, &full));
    assert_eq!(b.paint_digest(), want, "the revisit does not draw the mesh");
}

#[test]
fn the_next_transaction_absorbs_an_arrived_payload() {
    let (mut s, full, h) = tex_scene();
    let empty = PayloadStore::default();
    let mut b = applier();
    b.defer(h);
    b.apply(&s, &full_delta_tex(&s), &empty);
    // The next transaction moves another item; the payload arrived meanwhile.
    s.items.get_mut(&C2).unwrap().xform[4] += 20.0;
    let d = TxDelta {
        seq: 2,
        items_upserted: vec![C2],
        ..TxDelta::default()
    };
    b.prepare(&s, &d);
    assert!(
        !b.revisit(&s, &full),
        "a revisit ran over a prepared transaction"
    );
    assert!(b.absorb_deferred(&s, &full));
    b.apply(&s, &d, &full);
    let (want, _) = oracle(&s, &full_delta_tex(&s), &full);
    assert_eq!(
        b.paint_digest(),
        want,
        "the transaction's apply did not draw the arrived texture"
    );
    // C1 draws the texture: the item itself was never upserted again.
    assert!(b.items.contains_key(&C1));
}
