//! Instruction-count bench (R4): decode + apply one committed golden recording, nothing timed.
//! `rs-core-bench-instr <recording> [repeats]` runs the whole recording through the validator
//! and the D7 applier `repeats` times (default 3) and prints a checksum of the last packed list,
//! so the work cannot be optimised away and a changed result is visible. Each case is its own
//! process, so `scripts/bench-instr.sh` reads one `Ir` total per case from cachegrind.
//! Built only with `--features bench-instr` (off by default: the library and wasm builds are
//! untouched).
use render_stream_core::apply::geom;
use render_stream_core::apply::payloads::PayloadStore;
use render_stream_core::apply::{Applier, Viewport};
use render_stream_core::validate::{Accepted, Options, Validator};
use render_stream_core::wire;
use std::process::ExitCode;

fn run(data: &[u8]) -> Result<(usize, u64), wire::Error> {
    let version = wire::version_of_magic(data)
        .ok_or_else(|| wire::Error::new("bad-magic", "not a render-stream recording"))?;
    let spans = wire::split_records(data, version)?;
    let mut v = Validator::new(spans[0].bytes(data), spans[0].offset, Options::new(version))?;
    let s = v.session();
    let size = s.viewport.presentation_size.unwrap_or(s.viewport.logical_size);
    let vp = Viewport {
        width: size[0].max(1) as u32,
        height: size[1].max(1) as u32,
        clear: s.clear_color,
        global_xform: geom::IDENTITY,
        cull_mask: s.viewport.canvas_cull_mask as u32,
        format: gsw_canvas_draw_list::Format::Rgb10A2,
    };
    let mut applier = Applier::new(vp);
    let mut payloads = PayloadStore::default();
    let mut need = Vec::new();
    let mut txs = 0usize;
    for span in &spans[1..] {
        match v.accept(span.bytes(data), span.offset)? {
            Accepted::Resource { hash } => {
                if let Some(b) = v.inline_payload(&hash) {
                    payloads.provide(b, &hash, version, true)?;
                }
            }
            Accepted::End | Accepted::ItemMeta => {}
            Accepted::Transaction => {
                payloads.accept_transaction(&v, span.bytes(data))?;
                applier.prepare(v.state(), v.delta());
                applier.needed(v.state(), v.delta(), &payloads, &mut need);
                if !need.is_empty() {
                    return Err(wire::Error::new(
                        "resource-unavailable",
                        "the case must be self-contained (inline payloads)",
                    ));
                }
                applier.apply(v.state(), v.delta(), &payloads);
                txs += 1;
            }
        }
    }
    let d = applier.paint_digest().to_hex();
    let sum = d.bytes().fold(0u64, |a, b| a.wrapping_mul(131).wrapping_add(b as u64));
    Ok((txs, sum))
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: rs-core-bench-instr <recording> [repeats]");
        return ExitCode::from(2);
    };
    let repeats: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(3);
    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut last = (0, 0);
    for _ in 0..repeats {
        match run(&data) {
            Ok(r) => last = std::hint::black_box(r),
            Err(e) => {
                eprintln!("{path}: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    println!("transactions {} paint-checksum {:016x}", last.0, last.1);
    ExitCode::SUCCESS
}
