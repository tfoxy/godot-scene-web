//! PM6b: GSW's /12 emitters over golden-12's particles states (22-26): `describe` lists what
//! changed, an emitter draws as an instanced draw of its draw pass mesh once the shell sets its
//! simulated buffer, and the receiver sabotage `undrawn-particles` is the pre-PM6 executor.

use super::payloads::PayloadStore;
use super::{geom, particles, Applier, Viewport};
use crate::validate::{Accepted, Options, Validator};
use crate::wire;
use gsw_canvas_draw_list::DRAW_INSTANCED;
use std::path::PathBuf;

struct Seen {
    /// Per applied transaction: (seq, instanced draws, describe() was non-empty).
    frames: Vec<(i64, usize, bool)>,
    messages: Vec<String>,
    undrawn: u64,
    drawn: u64,
}

fn replay(file: &str, buffers: bool, undrawn: bool) -> Seen {
    let data = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../protocol/golden-12")
            .join(file),
    )
    .unwrap();
    let spans = wire::split_records(&data, 12).unwrap();
    let mut v = Validator::new(spans[0].bytes(&data), spans[0].offset, Options::new(12)).unwrap();
    let s = v.session();
    let size = s
        .viewport
        .presentation_size
        .unwrap_or(s.viewport.logical_size);
    let mut a = Applier::new(Viewport {
        width: size[0].max(1) as u32,
        height: size[1].max(1) as u32,
        clear: s.clear_color,
        global_xform: geom::IDENTITY,
        cull_mask: s.viewport.canvas_cull_mask as u32,
        format: gsw_canvas_draw_list::Format::Rgb10A2,
    });
    a.sabotage.lower.undrawn_particles = undrawn;
    let mut store = PayloadStore::default();
    let mut seen = Seen {
        frames: Vec::new(),
        messages: Vec::new(),
        undrawn: 0,
        drawn: 0,
    };
    for span in &spans[1..] {
        let rec = span.bytes(&data);
        match v.accept(rec, span.offset).unwrap() {
            Accepted::Resource { hash } => {
                let b = v.inline_payload(&hash).unwrap().to_vec();
                if crate::payload::payload_kind(&b, 12) != crate::payload::PayloadKind::Ktx2 {
                    store.provide(&b, &hash, 12, true).unwrap();
                }
            }
            Accepted::End => {}
            Accepted::Transaction => {
                store.accept_transaction(&v, rec).unwrap();
                let st = v.state();
                store.particles.retain(st);
                let msg = particles::describe(st, &mut store, false, false);
                if buffers {
                    for (id, p) in st.particles.iter() {
                        if p.status == crate::state::EntryStatus::Ok {
                            let n = p.amount.max(0) as usize * particles::PT_INSTANCE_FLOATS;
                            let mut f = vec![0.0f32; n];
                            // one visible instance: identity scale 2 at (1, 1), white
                            if n > 0 {
                                f[..16].copy_from_slice(&[
                                    2.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0,
                                    0.0, 0.0, 0.0, 1.0,
                                ]);
                            }
                            store.particles.set(*id, &f);
                        }
                    }
                }
                a.prepare(st, v.delta());
                a.apply(st, v.delta(), &store);
                let instanced = a
                    .list
                    .draws
                    .iter()
                    .filter(|d| d.flags & DRAW_INSTANCED != 0)
                    .count();
                seen.frames.push((st.seq, instanced, !msg.is_empty()));
                seen.messages.push(msg);
                a.list.consumed();
            }
        }
    }
    let total = |k: &str| a.shortcut_totals.get(k).copied().unwrap_or(0);
    seen.undrawn = total("particles-undrawn");
    seen.drawn = a.particles_commands;
    seen
}

#[test]
fn golden_12_particles_draw_from_the_shells_buffers() {
    // inline.rs12 carries its payloads (full.rs12 needs them fetched).
    for file in ["inline.rs12"] {
        let honest = replay(file, true, false);
        assert!(honest.drawn >= 1, "{file}: an add_particles drew instanced");
        assert_eq!(honest.undrawn, 0);
        assert!(honest.frames.iter().any(|f| f.1 >= 1), "{file}");
        // Every message is JSON naming the emitters; the first lists their builtin key.
        let first = honest
            .messages
            .iter()
            .find(|m| !m.is_empty())
            .expect("a describe message");
        assert!(
            crate::json::Doc::parse(first.as_bytes()).is_ok(),
            "describe is JSON: {first}"
        );
        assert!(first.contains("\"emitters\":[{"), "{first}");
        // A state with no particles change describes nothing.
        assert!(
            honest.frames.iter().any(|f| !f.2),
            "{file}: describe stays quiet when nothing moved"
        );
        // No buffer from the shell: every add_particles is typed, never drawn.
        let none = replay(file, false, false);
        assert_eq!(none.drawn, 0);
        // The sabotage: the pre-PM6 executor.
        let sab = replay(file, true, true);
        assert_eq!(sab.drawn, 0);
        assert!(sab.undrawn >= 1);
    }
}
