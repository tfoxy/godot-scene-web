//! Whole executor output, before consumption, at a selectable apply cadence.
//! `--group-merge undo` restores only the group permutation before hashing, so its output can be
//! compared with `--group-merge off` to detect changes beyond reordered copies, children and indices.
//! `--group-merge verify` also checks every merge against its exact pre-merge input, including all
//! list fields and the next apply's restored table. Independent processes replaying the same
//! recording at the same cadence must produce identical digests, including binding slots and
//! dirty-range order. The merge check also compares variants within each apply.

use super::{fill_cmd, list_digest, usage, Args};
use render_stream_core::apply::{
    geom, overrides::Refresh, payloads::PayloadStore, retention::Retention, Applier, Viewport,
};
use render_stream_core::validate::{Accepted, DigestPolicy, Options, Validator};
use render_stream_core::wire::{self, Error};
use std::io::Write;
use std::path::Path;
use std::process::ExitCode;

// The list's Debug digest includes ALL buffers, dirty ranges, bindings, upload bytes, screen
// operations, instances and depth tables. Also retain the pre-cover draws and cover decisions.
// Surface pass order, clears and frees are executor inputs too. No timings enter this digest.
fn output_digest(a: &Applier, undo_merge: bool) -> String {
    output_digest_mode(a, undo_merge, false, false)
}

fn output_digest_mode(a: &Applier, undo_merge: bool, legacy_groups: bool, loose: bool) -> String {
    use sha2::{Digest, Sha256};
    fn add(h: &mut Sha256, a: &Applier, undo_merge: bool, legacy_groups: bool, loose: bool) {
        let plain = undo_merge.then(|| a.unmerged_list());
        let list = plain.as_ref().unwrap_or(&a.list);
        let mut reduced;
        let list = if loose {
            reduced = list.clone();
            reduced.depth_tiles.clear();
            reduced.depth_draws.clear();
            reduced.dirty.draws = false;
            &reduced
        } else {
            list
        };
        if legacy_groups {
            // Compatibility oracle for output predating the optional group-cell field.
            let mut text = format!("{list:?}");
            let at = text.rfind(", group_cells: ").expect("last DrawList field");
            text.truncate(at);
            text.push_str(" }");
            h.update(Sha256::digest(text.as_bytes()));
        } else {
            h.update(list_digest(list).0);
        }
        let assembled = if undo_merge && a.assembled_draws() == a.list.draws {
            &list.draws
        } else {
            a.assembled_draws()
        };
        h.update(format!("{assembled:?}"));
        let s = &a.stats;
        if loose {
            h.update(format!("{} {} {} {}", s.covers, s.covered_draws, s.covered_ops, s.noop_draws));
        } else {
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
    }
    let mut h = Sha256::new();
    if let Some(set) = &a.surfaces {
        h.update(format!("freed {:?}", set.freed()));
        for (list, clear) in set.passes() {
            h.update(format!("pass {} {clear}", list.target.surface));
            let pass = set.applier(list.target.surface).expect("surface pass");
            add(&mut h, pass, undo_merge, legacy_groups, loose);
        }
    }
    h.update(b"root");
    add(&mut h, a, undo_merge, legacy_groups, loose);
    render_stream_core::wire::hex(&h.finalize())
}

#[derive(Clone, Copy, Default)]
struct ReplayOptions<'a> {
    deferred_cover: bool,
    settle_skips_refresh: bool,
    overrides: bool,
    digest: &'a str,
    recheck_every: usize,
    tiles_off: bool,
    tiles_schedule: usize,
}

/// Select game-visible drawn items so neither cover nor a previous override changes the driver.
fn synthetic_overrides(a: &mut Applier, state: &render_stream_core::state::ResolvedState, applies: usize) -> Result<(), Error> {
    let mut ids: Vec<_> = a.lowered_items().into_iter()
        .filter(|(id, lowered)| id % 17 == 0 && !lowered.draws.is_empty()
            && a.query_item(state, *id).is_some_and(|q| q.visible))
        .map(|(id, _)| id).collect();
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(32);
    let mut vals = Vec::with_capacity(ids.len() * render_stream_core::apply::overrides::OVERRIDE_FLOATS);
    for (i, &id) in ids.iter().enumerate() {
        let d = ((state.seq * 7 + id as i64).rem_euclid(9) - 4) as f32;
        let alpha = if applies % 2 == 0 { 1.0 } else { 0.5 };
        let visible = if i == 0 && (applies / 50) % 2 != 0 { 0.0 } else { 1.0 };
        vals.extend_from_slice(&[1.0, 0.0, 0.0, 1.0, d, d, 1.0, 1.0, 1.0, alpha, visible, 0.0, 0.0, 0.0, 0.0, 0.0]);
    }
    a.set_overrides(&ids, &vals).map_err(|e| Error::new("override-table", e))
}

fn replay(
    data: &[u8],
    every: usize,
    synthetic: bool,
    group_scissor: bool,
    group_merge: &str,
    legacy_groups: bool,
    options: ReplayOptions<'_>,
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
    a.set_deferred_cover(options.deferred_cover);
    let mut tiles_on = !options.tiles_off;
    a.set_cover_tiles(tiles_on);
    a.ov_sabotage.settle_skips_refresh = options.settle_skips_refresh;
    a.set_group_scissor(group_scissor);
    a.set_group_merge(group_merge != "off");
    a.set_group_merge_check(group_merge == "verify");
    let mut payloads = PayloadStore::default();
    let mut retention = Retention::default();
    let mut need = Vec::new();
    let mut rows = Vec::new();
    let mut programs = 1;
    let mut held = None;
    let mut applies = 0usize;
    let mut refreshes = [0usize; 4];
    let mut early_settles = 0usize;
    let mut apply = |a: &mut Applier,
                     v: &Validator,
                     payloads: &mut PayloadStore,
                     retention: &mut Retention,
                     delta: &render_stream_core::state::TxDelta|
     -> Result<String, Error> {
        if synthetic {
            fill_cmd::register_synthetic_programs(a, v.state(), payloads, &mut programs, None)?;
        }
        // The first N applies use the initial setting; the next apply sees the first flip.
        if options.tiles_schedule > 0 && applies > 0 && applies % options.tiles_schedule == 0 {
            tiles_on = !tiles_on;
            a.set_cover_tiles(tiles_on);
        }
        a.apply(v.state(), delta, payloads);
        applies += 1;
        early_settles += usize::from(options.deferred_cover && !a.cover_due());
        if options.overrides {
            synthetic_overrides(a, v.state(), applies)?;
            let r = a.refresh_overrides(v.state(), payloads);
            refreshes[match r { Refresh::Clean => 0, Refresh::Moved => 1, Refresh::Walked => 2, Refresh::Deferred => 3 }] += 1;
        }
        a.settle_cover();
        if options.recheck_every > 0 && applies % options.recheck_every == 0 && !a.cover_recheck() {
            return Err(Error::new("cover-recheck", format!("mismatch at seq {} (apply {applies})", v.state().seq)));
        }
        let digest = if options.digest == "off" {
            String::new()
        } else {
            output_digest_mode(a, matches!(group_merge, "undo" | "verify"), legacy_groups, options.digest == "loose")
        };
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
    if options.deferred_cover {
        eprintln!("cover: early_settles={early_settles} applies={applies}");
    }
    if options.overrides {
        eprintln!("overrides: Clean={} Moved={} Walked={} Deferred={}", refreshes[0], refreshes[1], refreshes[2], refreshes[3]);
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
    let group_merge = match args.get("group-merge").unwrap_or("on") {
        mode @ ("on" | "off" | "undo" | "verify") => mode,
        _ => return usage(),
    };
    let synthetic = match args.get("programs").unwrap_or("synthetic") {
        "synthetic" => true,
        "unregistered" => false,
        _ => return usage(),
    };
    let deferred_cover = match args.get("cover").unwrap_or("eager") {
        "eager" => false,
        "deferred" => true,
        _ => return usage(),
    };
    let settle_skips_refresh = match args.get("sabotage") {
        None => false,
        Some("settle_skips_refresh") => true,
        _ => return usage(),
    };
    let overrides = match args.get("overrides").unwrap_or("off") {
        "off" => false,
        "synthetic" => true,
        _ => return usage(),
    };
    let digest = match args.get("digest").unwrap_or("full") {
        mode @ ("full" | "loose" | "off") => mode,
        _ => return usage(),
    };
    let recheck_every = match args.get("recheck-every").unwrap_or("0").parse::<usize>() {
        Ok(n) => n,
        _ => return usage(),
    };
    let tiles_off = match args.get("tiles").unwrap_or("on") {
        "on" => false,
        "off" => true,
        _ => return usage(),
    };
    let tiles_schedule = match args.get("tiles-schedule").unwrap_or("0").parse::<usize>() {
        Ok(n) => n,
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
        let rows = replay(
            &data, every, synthetic, args.get("group-scissor") != Some("off"), group_merge, args.get("group-cells") == Some("omit"), ReplayOptions { deferred_cover, settle_skips_refresh, overrides, digest, recheck_every, tiles_off, tiles_schedule }, &mut read,
        )?;
        if group_merge == "verify" {
            eprintln!(
                "verified {} applies / {} transactions: whole list, permutation, restore",
                rows.iter().filter(|(_, digest)| digest.is_some()).count(), rows.len()
            );
        }
        for (seq, digest) in rows.into_iter().filter(|_| digest != "off") {
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
        let rows = replay(data, 2, true, true, "on", false, ReplayOptions::default(), &mut |_| None).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows[0].1.is_none());
        assert!(rows[1].1.is_some());
        assert!(rows[2].1.is_some());
        assert_eq!(rows, replay(data, 2, true, true, "on", false, ReplayOptions::default(), &mut |_| None).unwrap());
    }

    #[test]
    fn loose_digest_omits_only_depth_and_tile_outputs() {
        let mut a = Applier::new(Viewport {
            width: 1, height: 1, clear: [0.0; 4], global_xform: geom::IDENTITY,
            cull_mask: 1, format: gsw_canvas_draw_list::Format::Rgb10A2,
        });
        let loose = output_digest_mode(&a, false, false, true);
        let full = output_digest(&a, false);
        a.list.depth_tiles.push(gsw_canvas_draw_list::DepthTile::default());
        a.list.dirty.draws = !a.list.dirty.draws;
        a.stats.tile_tested += 1;
        assert_eq!(loose, output_digest_mode(&a, false, false, true));
        assert_ne!(full, output_digest(&a, false));
        a.list.instances.push(gsw_canvas_draw_list::Instance::default());
        assert_ne!(loose, output_digest_mode(&a, false, false, true));
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
        let original = output_digest(&a, false);
        a.list
            .depth_tiles
            .push(gsw_canvas_draw_list::DepthTile::default());
        assert_ne!(original, output_digest(&a, false));
        a.list.depth_tiles.clear();
        a.list.group_cells.push(gsw_canvas_draw_list::GroupCells::default());
        assert_ne!(original, output_digest(&a, false));
        a.list.group_cells.clear();
        a.stats.covered_draws += 1;
        assert_ne!(original, output_digest(&a, false));
        a.stats.covered_draws = 0;
        a.list
            .instances
            .push(gsw_canvas_draw_list::Instance::default());
        assert_ne!(original, output_digest(&a, false));
    }
}
