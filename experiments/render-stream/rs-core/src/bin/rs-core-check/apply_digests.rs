//! Whole executor output, before consumption, at a selectable apply cadence.

use super::{fill_cmd, list_digest, usage, Args};
use render_stream_core::apply::{
    geom, payloads::PayloadStore, retention::Retention, Applier, Viewport,
};
use render_stream_core::validate::{Accepted, DigestPolicy, Options, Validator};
use render_stream_core::wire::{self, Error};
use std::io::Write;
use std::path::Path;
use std::process::ExitCode;

// The list's Debug digest includes ALL buffers, dirty ranges, bindings, upload bytes, screen
// operations, instances and depth tables. Also retain the pre-cover draws and cover decisions.
// Surface pass order, clears and frees are executor inputs too. No timings enter this digest.
fn output_digest(a: &Applier) -> String {
    use sha2::{Digest, Sha256};
    fn add(h: &mut Sha256, a: &Applier) {
        h.update(list_digest(&a.list).0);
        h.update(format!("{:?}", a.assembled_draws()));
        let s = &a.stats;
        h.update(format!(
            "{} {} {} {} {} {} {}",
            s.covers,
            s.covered_draws,
            s.covered_ops,
            s.noop_draws,
            s.tile_covers,
            s.tile_tested,
            s.tile_hidden_px
        ));
    }
    let mut h = Sha256::new();
    if let Some(set) = &a.surfaces {
        h.update(format!("freed {:?}", set.freed()));
        for (list, clear) in set.passes() {
            h.update(format!("pass {} {clear}", list.target.surface));
            let pass = set.applier(list.target.surface).expect("surface pass");
            add(&mut h, pass);
        }
    }
    h.update(b"root");
    add(&mut h, a);
    format!("{:x}", h.finalize())
}

fn replay(
    data: &[u8],
    every: usize,
    synthetic: bool,
    group_scissor: bool,
    read: &mut dyn FnMut(&render_stream_core::state::Hash) -> Option<Vec<u8>>,
) -> Result<Vec<(i64, Option<String>)>, Error> {
    let version = wire::version_of_magic(data)
        .ok_or_else(|| Error::new("bad-magic", "not a render-stream recording"))?;
    let spans = wire::split_records(data, version)?;
    let mut opts = Options::new(version);
    opts.digest = DigestPolicy::Deferred;
    let mut v = Validator::new(spans[0].bytes(data), spans[0].offset, opts)?;
    let s = v.session();
    let vp = &s.viewport;
    let size = vp.presentation_size.unwrap_or(vp.logical_size);
    let mut a = Applier::new(Viewport {
        width: size[0].max(1) as u32,
        height: size[1].max(1) as u32,
        clear: s.clear_color,
        global_xform: if vp.stretch.mode == "canvas_items" && size != vp.logical_size {
            s.host_final_xform
        } else {
            geom::IDENTITY
        },
        cull_mask: vp.canvas_cull_mask as u32,
        format: gsw_canvas_draw_list::Format::Rgb10A2,
    });
    a.set_group_scissor(group_scissor);
    let mut payloads = PayloadStore::default();
    let mut retention = Retention::default();
    let mut need = Vec::new();
    let mut rows = Vec::new();
    let mut programs = 1;
    let mut held = None;
    let mut apply = |a: &mut Applier,
                     v: &Validator,
                     payloads: &mut PayloadStore,
                     retention: &mut Retention,
                     delta: &render_stream_core::state::TxDelta|
     -> Result<String, Error> {
        if synthetic {
            fill_cmd::register_synthetic_programs(a, v.state(), payloads, &mut programs, None)?;
        }
        a.apply(v.state(), delta, payloads);
        let digest = output_digest(a);
        retention.sweep(v, payloads, || a.referenced_payload_hashes());
        a.list.consumed();
        if let Some(set) = a.surfaces.as_mut() {
            set.consumed();
        }
        Ok(digest)
    };
    for span in &spans[1..] {
        let rec = span.bytes(data);
        match v.accept(rec, span.offset)? {
            Accepted::Resource { hash } => {
                if let Some(b) = v.inline_payload(&hash) {
                    payloads.provide(b, &hash, version, false)?;
                }
            }
            Accepted::Transaction => {
                payloads.accept_transaction(&v, rec)?;
                retention.note(&v);
                retention.sweep(&v, &mut payloads, || a.referenced_payload_hashes());
                a.prepare(v.state(), v.delta());
                a.needed(v.state(), v.delta(), &payloads, &mut need);
                for hash in &need {
                    let bytes = read(hash)
                        .ok_or_else(|| Error::new("resource-unavailable", hash.to_hex()))?;
                    payloads.provide(&bytes, hash, version, true)?;
                }
                held = if (rows.len() + 1) % every != 0 {
                    Some(v.delta().clone())
                } else {
                    None
                };
                let digest = if held.is_some() {
                    None
                } else {
                    Some(apply(&mut a, &v, &mut payloads, &mut retention, v.delta())?)
                };
                rows.push((v.state().seq, digest));
            }
            _ => {}
        }
    }
    if let Some(delta) = held {
        rows.last_mut().expect("held transaction").1 =
            Some(apply(&mut a, &v, &mut payloads, &mut retention, &delta)?);
    }
    Ok(rows)
}

pub(super) fn cmd(args: &Args) -> ExitCode {
    let Some(path) = args.positional.first() else {
        return usage();
    };
    let every = match args.get("apply-every").unwrap_or("1").parse::<usize>() {
        Ok(n) if n > 0 => n,
        _ => return usage(),
    };
    let synthetic = match args.get("programs").unwrap_or("synthetic") {
        "synthetic" => true,
        "unregistered" => false,
        _ => return usage(),
    };
    let run = || -> Result<(), Error> {
        let data = std::fs::read(path).map_err(|e| Error::new("io", e.to_string()))?;
        let mut read = |h: &render_stream_core::state::Hash| {
            let dir = Path::new(args.get("store")?).join("sha256");
            ["grt", "grm", "grp"]
                .iter()
                .find_map(|ext| std::fs::read(dir.join(format!("{}.{ext}", h.to_hex()))).ok())
        };
        let mut out = std::io::BufWriter::new(std::io::stdout().lock());
        for (seq, digest) in replay(&data, every, synthetic, args.get("group-scissor") != Some("off"), &mut read)? {
            writeln!(out, "{seq} {}", digest.as_deref().unwrap_or("pending"))
                .map_err(|e| Error::new("io", e.to_string()))?;
        }
        out.flush().map_err(|e| Error::new("io", e.to_string()))
    };
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("rs-core-check apply-digests: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_digest_includes_the_final_short_group() {
        let data = include_bytes!("../../../../protocol/golden-7/window2.rs7");
        let rows = replay(data, 2, true, true, &mut |_| None).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows[0].1.is_none());
        assert!(rows[1].1.is_some());
        assert!(rows[2].1.is_some());
        assert_eq!(rows, replay(data, 2, true, true, &mut |_| None).unwrap());
    }

    #[test]
    fn digest_covers_executor_and_cover_inputs() {
        let mut a = Applier::new(Viewport {
            width: 1,
            height: 1,
            clear: [0.0; 4],
            global_xform: geom::IDENTITY,
            cull_mask: 1,
            format: gsw_canvas_draw_list::Format::Rgb10A2,
        });
        let original = output_digest(&a);
        a.list
            .depth_tiles
            .push(gsw_canvas_draw_list::DepthTile::default());
        assert_ne!(original, output_digest(&a));
        a.list.depth_tiles.clear();
        a.stats.covered_draws += 1;
        assert_ne!(original, output_digest(&a));
        a.stats.covered_draws = 0;
        a.list
            .instances
            .push(gsw_canvas_draw_list::Instance::default());
        assert_ne!(original, output_digest(&a));
    }
}
