//! `rs-core-check fill`: per-pass fill accounting of the applier's packed list over a recording.

use super::{synthetic_meta, usage, Args};
use render_stream_core::validate::{Accepted, Options, Validator};
use render_stream_core::wire;
use serde_json::{json, Value as J};
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

fn group_owner_textures(
    merged: &gsw_canvas_draw_list::DrawList,
    unmerged: &gsw_canvas_draw_list::DrawList,
) -> Vec<Option<u32>> {
    // Restoring the permutation preserves group order; only unmerged ranges end at
    // their own composite. Keep the caller's reported ranges in merged coordinates.
    merged
        .group_cells
        .iter()
        .zip(&unmerged.group_cells)
        .map(|(_, g)| unmerged.draws.get(g.draws.end).map(|d| d.texture))
        .collect()
}

/// `fill <recording> [--store <dir>] [--seqs a,b,...] [--every N] [--cell 8] [--damage <file>]`:
/// replays every transaction through the applier (natively, no GL) and, after each listed seq
/// (or every Nth transaction, default every one), prints one JSON line of
/// `gsw_canvas_draw_list::fill::account` over the packed list: the pixels each kind of pass
/// touches (the target clear, opaque and blended draws, item-space programs and screen readers,
/// canvas-group draws into the back buffer and their composites, back-buffer copies, clears and
/// mip chains, the present), as pixels and as multiples of the target, the target render passes a
/// tiler sees, layers per pixel and the fragments a later opaque draw hides. Natively there is no
/// transpiler, so every shader gets a synthetic program whose screen sampling and `TIME` use come
/// from its code. A texture counts as opaque when its RGBA8 upload has no alpha below 255, and a
/// draw when every texel it samples is (a barycentric grid of samples inside each triangle).
/// `--draws <dir>` writes, for each printed transaction, `<dir>/draws-<seq>.jsonl`: one line per
/// draw (class, fragments, bounds, blend, texture, program, the opaque share of its sampled
/// texels and its first vertex's colour and modulate alpha).
/// The applier's cover walk runs as it does in a client (`--cover off` turns it off, `--noop off`
/// only its no-op drops): the list accounted is what an executor would draw. Each line also
/// reports `covered_draws` and `covered_ops`, what the walk left out of that transaction's list,
/// and `noop_draws`, the draws among them that change no pixel at all. `--tiles off` turns the
/// walk's tile half off; with it on, `total_screens` excludes the fragments the executor's depth
/// test rejects (`depth_rejected_screens`) and the depth-only tile pre-pass is reported on its own
/// (`depth_prepass_screens`). Gated group cells also subtract rejected back-buffer fragments,
/// split by builtin, program and instanced draws in `group_rejected_screens`; use
/// `--group-cells off` to account only C0 scissors and ordinary cover tiles.
/// `--damage <file>` plans exact redraw regions, once per `--damage-every N` transactions
/// (default 1), against the last planned execution. Its summary includes plan fractions, full
/// reasons and their top five draw/op triggers, region/area/call distributions, structural changes
/// and scissored fill costs. `--pin-time` holds shader time at the first planned frame for hashing.
pub(crate) fn cmd_fill(args: &Args) -> ExitCode {
    use gsw_canvas_draw_list::fill::{self, Class, FillOptions};
    use gsw_canvas_draw_list::TextureOp;
    use render_stream_core::apply::geom;
    use render_stream_core::apply::payloads::PayloadStore;
    use render_stream_core::apply::{Applier, Viewport};
    use std::collections::{HashMap, HashSet};
    let Some(path) = args.positional.first() else {
        return usage();
    };
    let store = args.get("store").map(PathBuf::from);
    let seqs: Option<Vec<i64>> = args
        .get("seqs")
        .map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect());
    let every: usize = args
        .get("every")
        .and_then(|s| s.parse().ok())
        .unwrap_or(1)
        .max(1);
    let cell: u32 = args.get("cell").and_then(|s| s.parse().ok()).unwrap_or(8);
    let damage_out = args.get("damage").map(PathBuf::from);
    let damage_every = match args.get("damage-every") {
        None => 1,
        Some(v) => match v.parse::<usize>() {
            Ok(n) if n > 0 => n,
            _ => {
                eprintln!("rs-core-check fill: --damage-every must be a positive integer");
                return ExitCode::FAILURE;
            }
        },
    };
    let draws_dir = args.get("draws").map(PathBuf::from);
    let run = || -> Result<(), wire::Error> {
        let data = std::fs::read(path)
            .map_err(|e| wire::Error::new("recording-unreadable", e.to_string()))?;
        let version = wire::version_of_magic(&data)
            .ok_or_else(|| wire::Error::new("bad-magic", "not a render-stream recording"))?;
        let spans = wire::split_records(&data, version)?;
        let mut v = Validator::new(
            spans[0].bytes(&data),
            spans[0].offset,
            Options::new(version),
        )?;
        if let Some(d) = draws_dir.as_ref() {
            std::fs::create_dir_all(d).map_err(|e| wire::Error::new("io", e.to_string()))?;
        }
        let s = v.session();
        let vp = &s.viewport;
        let size = vp.presentation_size.unwrap_or(vp.logical_size);
        // The client in the session's own presentation adopts the host's final transform.
        let global = if vp.stretch.mode == "canvas_items" && size != vp.logical_size {
            s.host_final_xform
        } else {
            geom::IDENTITY
        };
        let mut a = Applier::new(Viewport {
            width: size[0].max(1) as u32,
            height: size[1].max(1) as u32,
            clear: s.clear_color,
            global_xform: global,
            cull_mask: vp.canvas_cull_mask as u32,
            format: gsw_canvas_draw_list::Format::Rgb10A2,
        });
        a.cover_walk = args.get("cover") != Some("off");
        a.set_cover_noops(args.get("noop") != Some("off"));
        a.set_cover_tiles(args.get("tiles") != Some("off"));
        a.set_group_scissor(args.get("group-scissor") != Some("off"));
        a.set_group_merge(args.get("group-merge") != Some("off"));
        a.set_group_cells(args.get("group-cells") != Some("off"));
        let mut payloads = PayloadStore::default();
        let mut need = Vec::new();
        let mut out = std::io::stdout().lock();
        // Per shader hash: (samples the screen, with mipmaps; reads TIME).
        let mut shader_use: HashMap<render_stream_core::state::Hash, (bool, bool)> = HashMap::new();
        let mut programs = 1u32;
        let mut opaque: HashSet<u32> = HashSet::new();
        // Per RGBA8 texture id: (width, height, alpha plane).
        let mut alpha: HashMap<u32, (u32, u32, Vec<u8>)> = HashMap::new();
        let mut revisions: HashMap<u32, u32> = HashMap::new();
        let mut n = 0usize;
        let mut damage = DamageRun::new(damage_every, args.get("pin-time").is_some());
        // `--damage-from`/`--damage-to`: count only plans whose transaction seq falls in the
        // window (every plan still runs and commits, so the reference list stays continuous).
        damage.naive = args.get("damage-compare-naive").map(|_| Default::default());
        damage.window = (
            args.get("damage-from").and_then(|s| s.parse().ok()),
            args.get("damage-to").and_then(|s| s.parse().ok()),
        );
        for span in &spans[1..] {
            match v.accept(span.bytes(&data), span.offset)? {
                Accepted::Resource { hash } => {
                    if let Some(b) = v.inline_payload(&hash) {
                        payloads.provide(b, &hash, version, true)?;
                    }
                }
                Accepted::End
                | Accepted::Tween
                | Accepted::ItemMeta
                | Accepted::ResourceHint { .. }
                | Accepted::ResourceUnhint { .. } => {}
                Accepted::Transaction => {
                    payloads.accept_transaction(&v, span.bytes(&data))?;
                    a.prepare(v.state(), v.delta());
                    a.needed(v.state(), v.delta(), &payloads, &mut need);
                    for h in &need {
                        let Some(dir) = store.as_ref() else { break };
                        for ext in ["grt", "grm", "grp"] {
                            let p = dir.join("sha256").join(format!("{}.{ext}", h.to_hex()));
                            if let Ok(b) = std::fs::read(&p) {
                                payloads.provide(&b, h, version, true)?;
                                break;
                            }
                        }
                    }
                    register_synthetic_programs(
                        &mut a,
                        v.state(),
                        &payloads,
                        &mut programs,
                        Some(&mut shader_use),
                    )?;
                    let covered = {
                        let st = a.apply(v.state(), v.delta(), &payloads);
                        (st.covered_draws, st.covered_ops, st.noop_draws)
                    };
                    for op in &a.list.texture_ops {
                        match *op {
                            TextureOp::Upload {
                                id,
                                bytes,
                                width,
                                height,
                            } => {
                                *revisions.entry(id).or_default() += 1;
                                let len = 4 * width as usize * height as usize;
                                let plane: Option<Vec<u8>> = a
                                    .list
                                    .texture_data(bytes, len)
                                    .map(|b| b.chunks_exact(4).map(|p| p[3]).collect());
                                let solid =
                                    plane.as_ref().is_some_and(|p| p.iter().all(|&x| x == 255));
                                if solid {
                                    opaque.insert(id);
                                } else {
                                    opaque.remove(&id);
                                }
                                match plane {
                                    Some(p) => {
                                        alpha.insert(id, (width, height, p));
                                    }
                                    None => {
                                        alpha.remove(&id);
                                    }
                                }
                            }
                            TextureOp::UploadCompressed { id, .. }
                            | TextureOp::UploadHalf { id, .. }
                            | TextureOp::Surface { id, .. }
                            | TextureOp::Free { id } => {
                                *revisions.entry(id).or_default() += 1;
                                opaque.remove(&id);
                                alpha.remove(&id);
                            }
                        }
                    }
                    let slots = a.list.bindings.len();
                    let mut screen_slots = vec![false; slots];
                    for k in 0..slots {
                        if let Some(key) = a.binding_key(k as u32) {
                            if let Some(&(sc, _)) = shader_use.get(&key.hash) {
                                screen_slots[k] = sc;
                            }
                        }
                    }
                    let seq = v.state().seq;
                    // Per draw: the opaque share of the texels inside its uv bounds (None: unknown),
                    // and whether its vertex colours and modulate are all opaque.
                    let l = &a.list;
                    let mut texel_share: Vec<Option<f64>> = Vec::with_capacity(l.draws.len());
                    let mut solid_colour: Vec<bool> = Vec::with_capacity(l.draws.len());
                    let mut opaque_draws: HashSet<u32> = HashSet::new();
                    for (d, draw) in l.draws.iter().enumerate() {
                        let first = draw.first_index as usize;
                        let end = (first + draw.index_count as usize).min(l.indices.len());
                        let (mut u0, mut v0, mut u1, mut v1) =
                            (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
                        let mut solid = true;
                        for &i in &l.indices[first..end] {
                            if let Some(vx) = l.vertices.get(i as usize) {
                                u0 = u0.min(vx.uv[0]);
                                v0 = v0.min(vx.uv[1]);
                                u1 = u1.max(vx.uv[0]);
                                v1 = v1.max(vx.uv[1]);
                                solid &= vx.color[3] >= 1.0
                                    && l.items
                                        .get(vx.item as usize)
                                        .is_some_and(|it| it.modulate[3] >= 1.0);
                            }
                        }
                        // Texels sampled inside each triangle (barycentric grid in uv space).
                        let share = alpha.get(&draw.texture).and_then(|(w, h, p)| {
                            if u1 < u0 || *w == 0 || *h == 0 {
                                return None;
                            }
                            let tex = |u: f32, v: f32| -> u8 {
                                let x = ((u.clamp(0.0, 1.0) * *w as f32) as u32).min(*w - 1);
                                let y = ((v.clamp(0.0, 1.0) * *h as f32) as u32).min(*h - 1);
                                p[(y * *w + x) as usize]
                            };
                            let (mut n, mut solid_n) = (0u64, 0u64);
                            const K: u32 = 24;
                            let mut k = first;
                            while k + 3 <= end {
                                let t: Vec<[f32; 2]> = (0..3)
                                    .filter_map(|j| {
                                        l.vertices.get(l.indices[k + j] as usize).map(|vx| vx.uv)
                                    })
                                    .collect();
                                k += 3;
                                if t.len() < 3 {
                                    continue;
                                }
                                for i in 0..K {
                                    for j in 0..(K - i) {
                                        let (a0, b0) = (
                                            (i as f32 + 0.33) / K as f32,
                                            (j as f32 + 0.33) / K as f32,
                                        );
                                        let c0 = 1.0 - a0 - b0;
                                        let u = t[0][0] * a0 + t[1][0] * b0 + t[2][0] * c0;
                                        let v = t[0][1] * a0 + t[1][1] * b0 + t[2][1] * c0;
                                        n += 1;
                                        if tex(u, v) == 255 {
                                            solid_n += 1;
                                        }
                                    }
                                }
                            }
                            Some(solid_n as f64 / n.max(1) as f64)
                        });
                        if solid && share.is_some_and(|s| s >= 0.999) {
                            opaque_draws.insert(d as u32);
                        }
                        texel_share.push(share);
                        solid_colour.push(solid);
                    }
                    let opts = FillOptions {
                        cell,
                        opaque_textures: Some(&opaque),
                        opaque_draws: Some(&opaque_draws),
                        screen_slots: Some(&screen_slots),
                        ..FillOptions::default()
                    };
                    if damage_out.is_some() {
                        let facts = FillDamageFacts {
                            revisions: &revisions,
                            applier: &a,
                        };
                        damage.counting = damage.window.0.is_none_or(|f: i64| seq >= f)
                            && damage.window.1.is_none_or(|t: i64| seq <= t);
                        damage.observe(&a.list, &facts, &opts);
                    }
                    let want = match &seqs {
                        Some(list) => list.contains(&seq),
                        None => n.is_multiple_of(every),
                    };
                    n += 1;
                    if want {
                        let r = fill::account(&a.list, &opts);
                        let screen = r.screen();
                        let mut classes = serde_json::Map::new();
                        for c in Class::ALL {
                            classes.insert(
                                c.name().to_string(),
                                json!({
                                    "count": r.count[c as usize],
                                    "px": r.px[c as usize].round(),
                                    "screens": (r.px[c as usize] / screen * 1000.0).round() / 1000.0,
                                    "share": (r.px[c as usize] / r.total() * 1000.0).round() / 1000.0,
                                }),
                            );
                        }
                        let large: Vec<J> = r
                            .large
                            .iter()
                            .map(|l| {
                                json!({"draw": l.draw, "of": a.list.draws.len(), "class": l.class.name(),
                                    "screens": (l.px / screen * 1000.0).round() / 1000.0,
                                    "bounds": l.bounds, "blend": l.blend, "program": l.program,
                                    "texture": l.texture, "alpha": l.alpha})
                            })
                            .collect();
                        let ops: Vec<J> = r
                            .ops
                            .iter()
                            .map(|o| {
                                json!({"before": o.before, "kind": format!("{:?}", o.kind),
                                    "region": o.region,
                                    "screens": (o.px / screen * 1000.0).round() / 1000.0})
                            })
                            .collect();
                        let owner_textures = if a.list.group_cells.is_empty() {
                            Vec::new()
                        } else {
                            group_owner_textures(&a.list, &a.unmerged_list())
                        };
                        let line = json!({
                            "seq": seq, "target": [r.width, r.height],
                            "draws": a.list.draws.len(), "triangles": a.list.indices.len() / 3,
                            "total_screens": (r.total() / screen * 1000.0).round() / 1000.0,
                            "classes": classes,
                            "target_passes": r.target_passes,
                            "back_buffer_passes": r.back_buffer_passes,
                            "back_buffer_cleared_passes": r.back_buffer_cleared_passes,
                            "layers": {"mean": (r.layers_mean * 100.0).round() / 100.0,
                                "p50": r.layers_p50, "p95": r.layers_p95, "max": r.layers_max},
                            "hidden_screens": (r.hidden_px / screen * 1000.0).round() / 1000.0,
                            "group_rejected_screens": {
                                "builtin": r.group_rejected_px[0] / screen,
                                "program": r.group_rejected_px[1] / screen,
                                "instanced": r.group_rejected_px[2] / screen,
                            },
                            "group_cells": a.list.group_cells.iter().map(|g| g.rects.len()).sum::<usize>(),
                            "groups": a.list.group_cells.iter().zip(owner_textures).map(|(g, owner)| json!({
                                "draws": [g.draws.start, g.draws.end],
                                "rects": g.rects.len(),
                                "owner_texture": owner,
                            })).collect::<Vec<_>>(),
                            "depth_rejected_screens": (r.depth_rejected_px / screen * 1000.0).round() / 1000.0,
                            "depth_prepass_screens": (r.depth_prepass_px / screen * 1000.0).round() / 1000.0,
                            "depth_tiles": a.list.depth_tiles.len(), "depth_draws": a.list.depth_draws.len(),
                            "tile_classified": a.stats.tile_classified,
                            "empty_draws": r.empty_draws,
                            "covered_draws": covered.0, "covered_ops": covered.1, "noop_draws": covered.2,
                            "large": large, "ops": ops,
                        });
                        let _ = writeln!(out, "{line}");
                        if let Some(dir) = draws_dir.as_ref() {
                            let mut w = std::io::BufWriter::new(
                                std::fs::File::create(dir.join(format!("draws-{seq}.jsonl")))
                                    .map_err(|e| wire::Error::new("io", e.to_string()))?,
                            );
                            // Each draw alone, through a one-draw view of the list.
                            let mut one = a.list.clone();
                            one.screen_ops.clear();
                            for (d, draw) in a.list.draws.iter().enumerate() {
                                one.draws.clear();
                                one.draws.push(*draw);
                                one.instanced.clear();
                                if let Ok(i) = a
                                    .list
                                    .instanced
                                    .binary_search_by_key(&(d as u32), |r| r.draw)
                                {
                                    let mut r = a.list.instanced[i];
                                    r.draw = 0;
                                    one.instanced.push(r);
                                }
                                // A one-draw view needs the same range remapping as depth draws.
                                one.group_cells = a
                                    .list
                                    .group_cells
                                    .iter()
                                    .filter(|g| g.draws.contains(&d))
                                    .map(|g| gsw_canvas_draw_list::GroupCells {
                                        draws: 0..1,
                                        rects: g.rects.clone(),
                                    })
                                    .collect();
                                // Its depth test, if listed (the tiles stay as they are).
                                one.depth_draws.clear();
                                if let Some(level) =
                                    gsw_canvas_draw_list::depth_level(&a.list, d as u32)
                                {
                                    one.depth_draws
                                        .push(gsw_canvas_draw_list::DepthDraw { draw: 0, level });
                                }
                                let od: HashSet<u32> = if opaque_draws.contains(&(d as u32)) {
                                    [0u32].into_iter().collect()
                                } else {
                                    HashSet::new()
                                };
                                let ss: Vec<bool> = screen_slots.clone();
                                let r1 = fill::account(
                                    &one,
                                    &FillOptions {
                                        cell: 64,
                                        large_fraction: 1e-12,
                                        opaque_draws: Some(&od),
                                        screen_slots: Some(&ss),
                                        ..opts.clone()
                                    },
                                );
                                let class = Class::ALL
                                    .iter()
                                    .copied()
                                    .filter(|c| !matches!(c, Class::Clear | Class::Present))
                                    .max_by(|x, y| {
                                        r1.px[*x as usize]
                                            .partial_cmp(&r1.px[*y as usize])
                                            .unwrap_or(std::cmp::Ordering::Equal)
                                    })
                                    .unwrap_or(Class::Blended);
                                let px = r1.total()
                                    - r1.px[Class::Clear as usize]
                                    - r1.px[Class::Present as usize];
                                let shader = if draw.program > 0 {
                                    a.binding_key(draw.program - 1).map(|k| {
                                        let code = payloads
                                            .shaders
                                            .get(&k.hash)
                                            .map(|c| c.as_str())
                                            .unwrap_or("");
                                        let names: Vec<&str> = code
                                            .lines()
                                            .filter_map(|ln| ln.trim().strip_prefix("uniform "))
                                            .filter_map(|ln| {
                                                ln.split(|ch: char| {
                                                    ch == ':' || ch == ';' || ch == '='
                                                })
                                                .next()
                                            })
                                            .map(|x| x.split_whitespace().last().unwrap_or(""))
                                            .collect();
                                        let vals: Vec<String> = a
                                            .list
                                            .bindings
                                            .get((draw.program - 1) as usize)
                                            .map(|b| {
                                                b.uniforms
                                                    .iter()
                                                    .map(|u| format!("{}={:?}", u.name, u.value))
                                                    .collect()
                                            })
                                            .unwrap_or_default();
                                        format!(
                                            "{}… uniforms {:?} values {:?}",
                                            &k.hash.to_hex()[..8],
                                            names,
                                            vals
                                        )
                                    })
                                } else {
                                    None
                                };
                                let line = json!({
                                    "draw": d, "class": class.name(),
                                    "screens": (px / screen * 10000.0).round() / 10000.0,
                                    "group_rejected_screens": r1.group_rejected_px.iter().sum::<f64>() / screen,
                                    "bounds": r1.large.first().map(|x| x.bounds),
                                    "blend": draw.blend, "texture": draw.texture, "program": draw.program,
                                    "flags": draw.flags, "tris": draw.index_count / 3,
                                    "texel_opaque": texel_share[d].map(|x| (x * 1000.0).round() / 1000.0),
                                    "colour_solid": solid_colour[d],
                                    "shader": shader,
                                    "sums": draw_sums(&a.list, d),
                                });
                                let _ = writeln!(w, "{line}");
                            }
                        }
                    }
                    // Model upload consumption only on planned frames. Texture operations are
                    // accounted above on every apply, so release their payloads independently.
                    let pending = damage_out.is_some()
                        && !(damage.transactions - 1).is_multiple_of(damage.every);
                    let dirty = pending.then(|| std::mem::take(&mut a.list.dirty));
                    a.list.consumed();
                    if let Some(dirty) = dirty {
                        a.list.dirty = dirty;
                    }
                }
            }
        }
        if let Some(p) = damage_out.as_ref() {
            std::fs::write(p, format!("{:#}\n", damage.report()))
                .map_err(|e| wire::Error::new("io", e.to_string()))?;
        }
        Ok(())
    };
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("rs-core-check fill: {e}");
            ExitCode::FAILURE
        }
    }
}

/// The synthetic program object is immutable for a code hash, so it never needs a relink
/// revision. Texture revisions include every upload, free and surface alias across skipped draws.
struct FillDamageFacts<'a> {
    revisions: &'a std::collections::HashMap<u32, u32>,
    applier: &'a render_stream_core::apply::Applier,
}
impl FillDamageFacts<'_> {
    fn info(&self, slot: u32) -> Option<&render_stream_core::apply::programs::ProgramInfo> {
        use render_stream_core::apply::programs::ProgramEntry;
        let key = self.applier.binding_key(slot)?;
        match self.applier.program_entry(&key.hash)? {
            ProgramEntry::Ready(info) => Some(info),
            _ => None,
        }
    }
}
impl gsw_canvas_draw_list::damage::DamageFacts for FillDamageFacts<'_> {
    fn texture_revision(&self, id: u32) -> u32 {
        self.revisions.get(&id).copied().unwrap_or(0)
    }
    fn program(&self, slot: u32) -> gsw_canvas_draw_list::cover::ProgramFacts {
        use gsw_canvas_draw_list::cover::ProgramFacts;
        self.info(slot)
            .map_or(ProgramFacts::UNKNOWN, |p| ProgramFacts {
                reads_screen: p.screen.is_some(),
                vertex_stage: p.vertex,
                alpha: p.alpha,
            })
    }
    fn reads_time(&self, slot: u32) -> bool {
        self.info(slot).is_some_and(|p| p.time)
    }
    fn admitted(&self, _: &gsw_canvas_draw_list::DrawList, _: usize) -> bool {
        true
    }
}

struct DamageRun {
    planner: gsw_canvas_draw_list::damage::Planner,
    naive: Option<gsw_canvas_draw_list::damage::Planner>,
    plan_us: Vec<f64>,
    every: usize,
    pin_time: bool,
    pinned_time: Option<f32>,
    triggers: std::collections::BTreeMap<
        String,
        std::collections::BTreeMap<gsw_canvas_draw_list::damage::FullTrigger, usize>,
    >,
    transactions: usize,
    counts: [usize; 3], // Skip, Full, Partial.
    reasons: std::collections::BTreeMap<String, usize>,
    structural: usize,
    regions: Vec<f64>,
    area: Vec<f64>,
    calls: Vec<f64>,
    changed_old: Vec<f64>,
    changed_new: Vec<f64>,
    changed: Vec<f64>,
    full_fill: Vec<f64>,
    planned_fill: Vec<f64>,
    partial_fill: Vec<f64>,
    history_reads: usize,
    window: (Option<i64>, Option<i64>),
    counting: bool,
}
impl DamageRun {
    fn new(every: usize, pin_time: bool) -> Self {
        Self {
            planner: gsw_canvas_draw_list::damage::Planner::new(),
            naive: None,
            plan_us: Vec::new(),
            every,
            pin_time,
            pinned_time: None,
            triggers: Default::default(),
            transactions: 0,
            counts: [0; 3],
            reasons: Default::default(),
            structural: 0,
            regions: Vec::new(),
            area: Vec::new(),
            calls: Vec::new(),
            changed_old: Vec::new(),
            changed_new: Vec::new(),
            changed: Vec::new(),
            full_fill: Vec::new(),
            planned_fill: Vec::new(),
            partial_fill: Vec::new(),
            history_reads: 0,
            window: (None, None),
            counting: true,
        }
    }
    fn observe(
        &mut self,
        list: &gsw_canvas_draw_list::DrawList,
        facts: &impl gsw_canvas_draw_list::damage::DamageFacts,
        opts: &gsw_canvas_draw_list::fill::FillOptions,
    ) -> Option<gsw_canvas_draw_list::damage::Plan> {
        use gsw_canvas_draw_list::{
            damage::{Plan, PlanOptions},
            fill,
        };
        let serial = self.transactions;
        self.transactions += 1;
        if !serial.is_multiple_of(self.every) {
            return None;
        }
        let mut pinned;
        let list = if self.pin_time {
            pinned = list.clone();
            pinned.shader_time = *self.pinned_time.get_or_insert(list.shader_time);
            &pinned
        } else {
            list
        };
        let started = std::time::Instant::now();
        let (plan, stats) = self.planner.plan(list, facts, &PlanOptions::default());
        let plan_us = started.elapsed().as_secs_f64() * 1_000_000.;
        if let Some(naive) = self.naive.as_mut() {
            let (reference, _) = naive.plan_naive(list, facts, &PlanOptions::default());
            assert_eq!(
                plan, reference,
                "damage Plan difference at transaction {serial}"
            );
            naive.commit();
        }
        if !self.counting {
            self.planner.commit();
            return Some(plan);
        }
        self.plan_us.push(plan_us);
        self.structural += usize::from(stats.structural);
        self.history_reads += stats.history_reads;
        self.regions.push(stats.region_count as f64);
        self.area.push(f64::from(stats.area_permille));
        self.calls.push(if stats.admitted_draws == 0 {
            0.
        } else {
            stats.replayed_draws as f64 / stats.admitted_draws as f64
        });
        self.changed_old.push(stats.changed_old as f64);
        self.changed_new.push(stats.changed_new as f64);
        self.changed
            .push((stats.changed_old + stats.changed_new) as f64);
        let screen = (f64::from(list.target.width) * f64::from(list.target.height)).max(1.);
        // Keep the diagnostic's existing coarse grid for fill accounting; the planner's own
        // cell size is independent of this accounting grid and of --every's output cadence.
        let opts = fill::FillOptions {
            cell: 16,
            ..opts.clone()
        };
        let full = fill::account(list, &opts).total() / screen;
        self.full_fill.push(full);
        let cost = match &plan {
            Plan::Skip => {
                self.counts[0] += 1;
                0.
            }
            Plan::Full(reason) => {
                self.counts[1] += 1;
                let reason = format!("{reason:?}");
                *self.reasons.entry(reason.clone()).or_default() += 1;
                for trigger in &stats.full_triggers {
                    *self
                        .triggers
                        .entry(reason.clone())
                        .or_default()
                        .entry(trigger.clone())
                        .or_default() += 1;
                }
                full
            }
            Plan::Partial {
                regions,
                back_regions,
            } => {
                self.counts[2] += 1;
                let cost = fill::account_partial(list, &opts, regions, back_regions)
                    .iter()
                    .sum::<f64>()
                    / screen;
                self.partial_fill.push(cost);
                cost
            }
        };
        self.planned_fill.push(cost);
        self.planner.commit();
        Some(plan)
    }
    fn top_triggers(&self, reason: &str) -> Vec<J> {
        let mut entries: Vec<_> = self
            .triggers
            .get(reason)
            .into_iter()
            .flat_map(|m| m.iter())
            .collect();
        entries.sort_by(|(a, ac), (b, bc)| bc.cmp(ac).then_with(|| a.cmp(b)));
        entries
            .into_iter()
            .take(5)
            .map(|(t, count)| {
                json!({
                    "draw": t.draw, "op": t.op, "program_slot": t.program_slot,
                    "bounds": t.bounds, "count": count,
                })
            })
            .collect()
    }
    fn report(&self) -> J {
        let frames = self.counts.iter().sum::<usize>();
        let fraction = |n| {
            if frames == 0 {
                0.
            } else {
                n as f64 / frames as f64
            }
        };
        json!({
            "transactions": self.transactions, "damage_every": self.every, "frames": frames,
            "plan_counts": {"skip": self.counts[0], "full": self.counts[1], "partial": self.counts[2]},
            "plan_fractions": {"skip": fraction(self.counts[0]), "full": fraction(self.counts[1]), "partial": fraction(self.counts[2])},
            "full_reasons": self.reasons,
            "pin_time": self.pin_time, "pinned_shader_time": self.pinned_time,
            "full_triggers": {
                "ScreenReader": self.top_triggers("ScreenReader"),
                "HistoryRead": self.top_triggers("HistoryRead"),
            },
            "plan_us": distribution(&self.plan_us),
            "region_count": distribution(&self.regions),
            "area_permille": distribution(&self.area),
            "replayed_admitted_ratio": distribution(&self.calls),
            "structural_change_frames": self.structural,
            "changed_draws": distribution(&self.changed),
            "changed_old_draws": distribution(&self.changed_old),
            "changed_new_draws": distribution(&self.changed_new),
            "history_reads": self.history_reads,
            "fill_full_screens": distribution(&self.full_fill),
            "fill_planned_screens": distribution(&self.planned_fill),
            "fill_partial_screens": distribution(&self.partial_fill),
        })
    }
}
fn distribution(values: &[f64]) -> J {
    if values.is_empty() {
        return json!({"mean": 0., "p50": 0., "p95": 0.});
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let q = |f: f64| sorted[((sorted.len() as f64 * f) as usize).min(sorted.len() - 1)];
    json!({"mean": values.iter().sum::<f64>() / values.len() as f64, "p50": q(0.5), "p95": q(0.95)})
}

/// `fill --draws`: per draw, sums of its screen positions, uvs, vertex colours and item modulates
/// (which of them moves between two transactions).
fn draw_sums(l: &gsw_canvas_draw_list::DrawList, d: usize) -> J {
    let draw = &l.draws[d];
    let first = draw.first_index as usize;
    let end = (first + draw.index_count as usize).min(l.indices.len());
    let (mut pos, mut uv, mut col, mut md) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for &i in &l.indices[first..end] {
        let Some(v) = l.vertices.get(i as usize) else {
            continue;
        };
        let x = l
            .items
            .get(v.item as usize)
            .map(|r| r.xform)
            .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        let (px, py) = (f64::from(v.pos[0]), f64::from(v.pos[1]));
        pos += f64::from(x[0]) * px + f64::from(x[2]) * py + f64::from(x[4]);
        pos += f64::from(x[1]) * px + f64::from(x[3]) * py + f64::from(x[5]);
        uv += f64::from(v.uv[0]) + f64::from(v.uv[1]);
        col += v.color.iter().map(|c| f64::from(*c)).sum::<f64>();
        md += l.items.get(v.item as usize).map_or(0.0, |r| {
            r.modulate.iter().map(|c| f64::from(*c)).sum::<f64>()
        });
    }
    json!([pos, uv, col, md])
}

/// Natively there is no transpiler: every shader `a` waits for gets a synthetic program whose
/// screen sampling (with mipmaps) and `TIME` use come from its code, its id taken from the code's
/// hash; `*next` counts the programs registered.
/// `shader_use` records (samples the screen, reads TIME) per shader hash.
pub(crate) fn register_synthetic_programs(
    a: &mut render_stream_core::apply::Applier,
    state: &render_stream_core::state::ResolvedState,
    payloads: &render_stream_core::apply::payloads::PayloadStore,
    next: &mut u32,
    mut shader_use: Option<
        &mut std::collections::HashMap<render_stream_core::state::Hash, (bool, bool)>,
    >,
) -> Result<(), wire::Error> {
    use render_stream_core::apply::programs::{ProgramEntry, ProgramInfo};
    for (sid, hash, _) in a.pending_shaders(state) {
        let code = payloads.shaders.get(&hash).cloned().unwrap_or_default();
        let screen = code.contains("hint_screen_texture");
        let mips = screen && code.contains("filter_linear_mipmap");
        let time = code.contains("TIME");
        if let Some(u) = shader_use.as_deref_mut() {
            u.insert(hash, (screen, time));
        }
        let mut meta = synthetic_meta(state, sid, &hash, &code);
        meta["vertexStage"] = J::Bool(false);
        meta["time"] = J::Bool(time);
        if screen {
            meta["screenTexture"] = json!({"names": ["screen_texture"], "mipmaps": mips});
        }
        // The blend its render_mode names, as the transpiler reads it (mix without one).
        for (mode, blend) in [
            ("blend_add", "add"),
            ("blend_sub", "sub"),
            ("blend_mul", "mul"),
            ("blend_premul_alpha", "premul_alpha"),
            ("blend_disabled", "disabled"),
        ] {
            if code.contains(mode) {
                meta["blend"] = J::String(blend.into());
            }
        }
        // The id follows the code, not the order shaders arrive in, so appliers replaying the same
        // recording side by side (`walk-diff --cover`) name every program alike.
        let id = u32::from_le_bytes([hash.0[0], hash.0[1], hash.0[2], hash.0[3] & 0x7f]).max(1);
        let info = ProgramInfo::from_meta_json(id, &meta.to_string())
            .map_err(|e| wire::Error::new("program", e.to_string()))?
            .with_code(&code);
        *next += 1;
        a.set_program(hash, ProgramEntry::Ready(info));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use render_stream_core::apply::payloads::PayloadStore;
    use render_stream_core::apply::{Applier, Viewport};
    use render_stream_core::state::*;

    #[test]
    fn damage_cli_samples_transactions_and_writes_planner_summary() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let out = root.join(format!(
            "../../../.local/damage-summary-{}.json",
            std::process::id()
        ));
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        let args = Args {
            positional: vec![root
                .join("../protocol/golden-13/full.rs13")
                .display()
                .to_string()],
            flags: vec![
                ("damage".into(), out.display().to_string()),
                ("damage-every".into(), "3".into()),
                ("seqs".into(), "-999".into()),
            ],
        };
        assert_eq!(cmd_fill(&args), ExitCode::SUCCESS);
        let report: J = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
        std::fs::remove_file(out).unwrap();
        let transactions = report["transactions"].as_u64().expect("transaction count");
        assert!(
            transactions > 3,
            "fixture must span multiple planned frames"
        );
        assert_eq!(report["damage_every"], 3);
        assert_eq!(report["frames"], transactions.div_ceil(3));
        let counts = &report["plan_counts"];
        assert_eq!(
            counts["skip"].as_u64().unwrap()
                + counts["full"].as_u64().unwrap()
                + counts["partial"].as_u64().unwrap(),
            report["frames"].as_u64().unwrap()
        );
        assert_eq!(report["full_reasons"]["First"], 1);
        for metric in [
            "region_count",
            "area_permille",
            "replayed_admitted_ratio",
            "changed_draws",
            "fill_planned_screens",
            "fill_partial_screens",
        ] {
            for stat in ["mean", "p50", "p95"] {
                assert!(
                    report[metric][stat].as_f64().unwrap().is_finite(),
                    "{metric}.{stat}"
                );
            }
        }
    }

    #[test]
    fn damage_cli_rejects_zero_cadence() {
        let args = Args {
            positional: vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../protocol/golden-13/full.rs13")
                .display()
                .to_string()],
            flags: vec![
                ("damage-every".into(), "0".into()),
                ("seqs".into(), "-999".into()),
            ],
        };
        assert_eq!(cmd_fill(&args), ExitCode::FAILURE);
    }

    #[test]
    fn damage_cadence_keeps_last_executed_list_and_sums_scissored_fill() {
        use gsw_canvas_draw_list::{
            cover::ProgramFacts,
            damage::{DamageFacts, Plan},
            fill::{self, FillOptions},
            Draw, DrawList, Item, Vertex,
        };
        struct Facts;
        impl DamageFacts for Facts {
            fn texture_revision(&self, _: u32) -> u32 {
                0
            }
            fn program(&self, _: u32) -> ProgramFacts {
                ProgramFacts::UNKNOWN
            }
            fn reads_time(&self, _: u32) -> bool {
                false
            }
            fn admitted(&self, _: &DrawList, _: usize) -> bool {
                true
            }
        }
        let mut list = DrawList::default();
        list.target.width = 256;
        list.target.height = 256;
        for x in [8., 72., 136., 200.] {
            let item = list.items.len() as u32;
            list.items.push(Item {
                xform: [1., 0., 0., 1., 0., 0.],
                modulate: [1.; 4],
                ..Item::default()
            });
            let base = list.vertices.len() as u32;
            for pos in [[x, 8.], [x + 8., 8.], [x + 8., 16.], [x, 16.]] {
                list.vertices.push(Vertex {
                    pos,
                    item,
                    color: [1.; 4],
                    ..Vertex::default()
                });
            }
            let first_index = list.indices.len() as u32;
            list.indices
                .extend([base, base + 1, base + 2, base, base + 2, base + 3]);
            list.draws.push(Draw {
                first_index,
                index_count: 6,
                ..Draw::default()
            });
        }
        let opts = FillOptions {
            cell: 16,
            ..FillOptions::default()
        };
        let mut run = DamageRun::new(3, false);
        run.naive = Some(Default::default());
        assert!(matches!(
            run.observe(&list, &Facts, &opts),
            Some(Plan::Full(_))
        ));
        list.items[0].xform[4] = 16.;
        list.dirty.items.add(0, 1);
        assert_eq!(run.observe(&list, &Facts, &opts), None);
        list.items[0].xform[4] = 0.;
        list.dirty.items.add(0, 1);
        assert_eq!(run.observe(&list, &Facts, &opts), None);
        assert_eq!(run.observe(&list, &Facts, &opts), Some(Plan::Skip));
        assert_eq!(run.observe(&list, &Facts, &opts), None);
        assert_eq!(run.observe(&list, &Facts, &opts), None);
        list.items[0].xform[4] = 8.;
        list.dirty.items.add(0, 1);
        let Some(Plan::Partial { regions, .. }) = run.observe(&list, &Facts, &opts) else {
            panic!("one moved draw must permit partial redraw");
        };
        let expected: f64 = regions
            .iter()
            .map(|r| {
                fill::account(
                    &list,
                    &FillOptions {
                        clip: Some(*r),
                        ..opts.clone()
                    },
                )
                .total()
                    / 65536.
            })
            .sum();
        let report = run.report();
        assert_eq!(run.plan_us.len(), 3);
        assert!(report["plan_us"]["p50"].as_f64().unwrap() > 0.);
        assert_eq!(
            report["plan_counts"],
            json!({"full": 1, "skip": 1, "partial": 1})
        );
        assert_eq!(
            report["fill_partial_screens"]["mean"].as_f64().unwrap(),
            expected
        );
        assert!(expected > 0. && expected < report["fill_full_screens"]["mean"].as_f64().unwrap());
    }

    struct TimeFacts;
    impl gsw_canvas_draw_list::damage::DamageFacts for TimeFacts {
        fn texture_revision(&self, _: u32) -> u32 {
            0
        }
        fn program(&self, _: u32) -> gsw_canvas_draw_list::cover::ProgramFacts {
            gsw_canvas_draw_list::cover::ProgramFacts {
                reads_screen: false,
                vertex_stage: false,
                alpha: None,
            }
        }
        fn reads_time(&self, _: u32) -> bool {
            true
        }
        fn admitted(&self, _: &gsw_canvas_draw_list::DrawList, _: usize) -> bool {
            true
        }
    }
    fn damage_quad(l: &mut gsw_canvas_draw_list::DrawList, r: [f32; 4]) {
        use gsw_canvas_draw_list::{Draw, Item, Vertex};
        let item = l.items.len() as u32;
        l.items.push(Item {
            xform: [1., 0., 0., 1., 0., 0.],
            modulate: [1.; 4],
            ..Item::default()
        });
        let b = l.vertices.len() as u32;
        for pos in [
            [r[0], r[1]],
            [r[0] + r[2], r[1]],
            [r[0] + r[2], r[1] + r[3]],
            [r[0], r[1] + r[3]],
        ] {
            l.vertices.push(Vertex {
                pos,
                color: [1.; 4],
                item,
                ..Vertex::default()
            });
        }
        let first_index = l.indices.len() as u32;
        l.indices.extend([b, b + 1, b + 2, b, b + 2, b + 3]);
        l.draws.push(Draw {
            first_index,
            index_count: 6,
            ..Draw::default()
        });
    }

    #[test]
    fn damage_pin_time_uses_first_planned_frame_without_mutating_input() {
        use gsw_canvas_draw_list::{damage::Plan, fill::FillOptions, Binding, DrawList};
        let mut l = DrawList::default();
        l.target.width = 256;
        l.target.height = 256;
        for x in [8., 72., 136., 200.] {
            damage_quad(&mut l, [x, 8., 8., 8.]);
        }
        l.draws[0].program = 1;
        l.bindings.push(Binding {
            program: 1,
            post_modulate: [1.; 4],
            uniforms: vec![],
            samplers: vec![],
        });
        l.shader_time = 12.;
        let mut pinned = DamageRun::new(3, true);
        let mut live = DamageRun::new(3, false);
        let opts = FillOptions::default();
        pinned.observe(&l, &TimeFacts, &opts);
        live.observe(&l, &TimeFacts, &opts);
        for time in [13., 14.] {
            l.shader_time = time;
            assert_eq!(pinned.observe(&l, &TimeFacts, &opts), None);
            assert_eq!(live.observe(&l, &TimeFacts, &opts), None);
        }
        l.shader_time = 15.;
        assert_eq!(pinned.observe(&l, &TimeFacts, &opts), Some(Plan::Skip));
        assert!(matches!(
            live.observe(&l, &TimeFacts, &opts),
            Some(Plan::Partial { .. })
        ));
        assert_eq!(l.shader_time, 15.);
        assert_eq!(pinned.report()["pinned_shader_time"], 12.);
        let raw: Vec<_> = ["recording", "--pin-time", "--damage", "out.json"]
            .map(String::from)
            .to_vec();
        let args = Args::parse(&raw).expect("boolean pin flag needs no argument");
        assert_eq!(args.get("pin-time"), Some("1"));
        assert_eq!(args.get("damage"), Some("out.json"));
    }

    #[test]
    fn damage_partial_fill_reports_target_and_back_work_once() {
        use gsw_canvas_draw_list::{
            damage::Plan, fill::FillOptions, DrawList, ScreenOp, ScreenOpKind,
            DRAW_GROUP_COMPOSITE, DRAW_SCREEN_OPS, DRAW_TO_BACK_BUFFER,
        };
        let mut l = DrawList::default();
        l.target.width = 128;
        l.target.height = 128;
        damage_quad(&mut l, [96., 96., 8., 8.]);
        damage_quad(&mut l, [0., 0., 128., 128.]);
        l.draws[1].flags |= DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS;
        damage_quad(&mut l, [96., 96., 8., 8.]);
        l.draws[2].flags |= DRAW_GROUP_COMPOSITE;
        for r in [[8., 8., 8., 8.], [48., 8., 8., 8.], [8., 48., 8., 8.]] {
            damage_quad(&mut l, r);
        }
        l.screen_ops.push(ScreenOp {
            before: 1,
            kind: ScreenOpKind::Clear,
            region: [0; 4],
            mipmaps: false,
            sample_mips: false,
        });
        let mut run = DamageRun::new(1, false);
        let opts = FillOptions::default();
        run.observe(&l, &TimeFacts, &opts);
        l.items[0].modulate[0] = 0.5;
        l.dirty.items.add(0, 1);
        let Some(Plan::Partial {
            regions,
            back_regions,
        }) = run.observe(&l, &TimeFacts, &opts)
        else {
            panic!("expected partial plan");
        };
        assert_eq!(regions, vec![[96, 96, 32, 32]]);
        assert_eq!(back_regions, vec![[64, 64, 64, 64]]);
        // Clear/present: 2*1024; target quads: 2*64; producer: 4096; back clear: 16384.
        assert_eq!(
            run.report()["fill_partial_screens"]["mean"],
            22656. / 16384.
        );
        assert_eq!(run.planned_fill[1], 22656. / 16384.);
    }

    #[test]
    fn damage_reason_triggers_are_counted_and_limited_to_five() {
        use gsw_canvas_draw_list::damage::FullTrigger;
        let mut run = DamageRun::new(1, false);
        for draw in 0..7 {
            let t = FullTrigger {
                draw,
                op: None,
                program_slot: Some(draw as u32),
                bounds: [draw as i32, 0, 8, 8],
            };
            run.triggers
                .entry("ScreenReader".into())
                .or_default()
                .insert(t, draw + 1);
        }
        let top = run.top_triggers("ScreenReader");
        assert_eq!(top.len(), 5);
        assert_eq!(
            top[0],
            json!({"draw":6,"op":null,"program_slot":6,"bounds":[6,0,8,8],"count":7})
        );
        assert_eq!(top[4]["draw"], 2);
        assert!(run.top_triggers("HistoryRead").is_empty());
    }

    #[test]
    fn damage_history_trigger_report_aggregates_executed_frames() {
        use gsw_canvas_draw_list::{
            damage::{FullReason, Plan},
            fill::FillOptions,
            DrawList, DRAW_GROUP_COMPOSITE,
        };
        let mut l = DrawList::default();
        l.target.width = 128;
        l.target.height = 128;
        damage_quad(&mut l, [8., 8., 8., 8.]);
        l.draws[0].flags |= DRAW_GROUP_COMPOSITE;
        let mut run = DamageRun::new(1, false);
        let opts = FillOptions::default();
        assert_eq!(
            run.observe(&l, &TimeFacts, &opts),
            Some(Plan::Full(FullReason::First))
        );
        for _ in 0..2 {
            assert_eq!(
                run.observe(&l, &TimeFacts, &opts),
                Some(Plan::Full(FullReason::HistoryRead))
            );
        }
        assert_eq!(
            run.report()["full_triggers"]["HistoryRead"],
            json!([
                {"draw":0, "op":null, "program_slot":null, "bounds":[8,8,8,8], "count":2}
            ])
        );
    }

    #[test]
    fn merged_groups_report_their_own_owner_textures() {
        use gsw_canvas_draw_list::cover::{
            groups::{GroupRange, GroupWalk},
            CoverFacts, ProgramFacts,
        };
        use gsw_canvas_draw_list::{
            opacity::Opacity, Draw, DrawList, Item, ScreenOp, ScreenOpKind, Vertex,
            DRAW_GROUP_CLIP, DRAW_SCREEN_OPS, DRAW_TO_BACK_BUFFER,
        };

        struct Facts([Opacity; 2]);
        impl CoverFacts for Facts {
            fn opacity(&self, id: u32) -> Option<&Opacity> {
                id.checked_sub(1).and_then(|i| self.0.get(i as usize))
            }
            fn program(&self, _: u32) -> ProgramFacts {
                ProgramFacts::UNKNOWN
            }
        }
        let facts = Facts(std::array::from_fn(|_| {
            Opacity::from_rgba8(16, 16, &[0; 16 * 16 * 4])
        }));
        let mut list = DrawList::default();
        list.target.width = 128;
        list.target.height = 32;
        list.items.push(Item {
            xform: [1., 0., 0., 1., 0., 0.],
            modulate: [1.; 4],
            ..Item::default()
        });
        let mut groups = Vec::new();
        for (owner, x) in [(1, 0.), (2, 80.)] {
            let base = list.vertices.len() as u32;
            for uv in [[0., 0.], [1., 0.], [1., 1.], [0., 1.]] {
                list.vertices.push(Vertex {
                    pos: [x + uv[0] * 48., uv[1] * 32.],
                    uv,
                    color: [1.; 4],
                    ..Vertex::default()
                });
            }
            let first_index = list.indices.len() as u32;
            list.indices.extend([0, 1, 2, 0, 2, 3].map(|i| i + base));
            let first = list.draws.len();
            let draw = Draw {
                first_index,
                index_count: 6,
                texture: owner,
                ..Draw::default()
            };
            list.draws.push(Draw {
                flags: DRAW_TO_BACK_BUFFER | DRAW_SCREEN_OPS,
                ..draw
            });
            list.draws.push(Draw {
                flags: DRAW_GROUP_CLIP,
                ..draw
            });
            groups.push(GroupRange {
                first,
                composite: first + 1..first + 2,
            });
            list.screen_ops.push(ScreenOp {
                before: first as u32,
                kind: ScreenOpKind::Copy,
                region: [0, 0, 128, 32],
                mipmaps: false,
                sample_mips: false,
            });
        }
        let mut walk = GroupWalk::default();
        walk.prepare(&list, &groups, &facts, true);
        walk.apply(&mut list);
        let plain = list.clone();
        assert_eq!(plain.group_cells.len(), 2);
        assert!(walk.merge(&mut list, &facts, true));
        assert!(walk.check_merge(&plain, &list));
        // The gate walk visits groups backwards, so the cell table is in B/A order.
        assert_eq!(list.group_cells[1].draws, 0..1);
        assert_eq!(list.group_cells[0].draws, 1..2);
        let mut restored = list.clone();
        walk.restore_merge_copy(&mut restored);
        assert_eq!(restored.group_cells, plain.group_cells);
        let owners = group_owner_textures(&list, &restored);
        assert_eq!(owners, [Some(2), Some(1)]);
        let mut by_draw = list.group_cells.iter().zip(owners).collect::<Vec<_>>();
        by_draw.sort_by_key(|(g, _)| g.draws.start);
        assert_eq!(
            by_draw.iter().map(|(_, owner)| *owner).collect::<Vec<_>>(),
            [Some(1), Some(2)]
        );
        assert_eq!(group_owner_textures(&plain, &plain), [Some(2), Some(1)]);
    }

    #[test]
    fn synthetic_replay_unset_threshold_changes_and_resets() {
        for instance in [false, true] {
            for default in [0.0, 0.5] {
                replay_threshold(instance, default);
            }
        }
    }

    fn replay_threshold(instance: bool, default: f64) {
        let mut code = include_str!("../../apply/fixtures/transition.gdshader").to_string();
        code = code.replace(
            "uniform float threshold : hint_range(0,1);",
            &format!(
                "{}uniform float threshold = {default:?};",
                if instance { "instance " } else { "" }
            ),
        );
        let data = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../protocol/golden-11/inline.rs11"),
        )
        .unwrap();
        let spans = wire::split_records(&data, 11).unwrap();
        let mut v =
            Validator::new(spans[0].bytes(&data), spans[0].offset, Options::new(11)).unwrap();
        for span in &spans[1..] {
            v.accept(span.bytes(&data), span.offset).unwrap();
        }
        let mut state = v.state().clone();
        let hash = Hash([0x71; 32]);
        let shader = 9001;
        let material = 9002;
        state.shaders.clear();
        state.materials.clear();
        state.shaders.insert(
            shader,
            Shader {
                id: shader,
                origin: Origin::Created,
                status: EntryStatus::Ok,
                reason: None,
                version: 1,
                mode: Some(ShaderMode::CanvasItem),
                source: Some(ShaderSource::Payload),
                hash: Some(hash),
                payload_bytes: 0,
                builtin: None,
                process: None,
                uses: Vec::new(),
                default_textures: Vec::new(),
            },
        );
        state.materials.insert(
            material,
            Material {
                id: material,
                origin: Origin::Created,
                status: EntryStatus::Ok,
                reason: None,
                version: 1,
                shader: Some(shader),
                params: vec![Param {
                    name: "transitionTex".into(),
                    ty: VariantType::Rid,
                    value: ParamValue::Tex(0),
                }],
            },
        );
        for id in state.items.keys().copied().collect::<Vec<_>>() {
            let item = state.items.get_mut(&id).unwrap();
            item.material = Some(material);
            item.use_parent_material = false;
        }
        let mut payloads = PayloadStore::default();
        payloads.shaders.insert(hash, code);
        let mut a = Applier::new(Viewport {
            width: 640,
            height: 360,
            clear: [0.0, 0.0, 0.0, 1.0],
            global_xform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            cull_mask: u32::MAX,
            format: gsw_canvas_draw_list::Format::Rgb10A2,
        });
        let mut next = 1;
        for (threshold, live) in [
            (None, default != 0.0),
            (Some(0.5), true),
            (None, default != 0.0),
        ] {
            state
                .materials
                .get_mut(&material)
                .unwrap()
                .params
                .retain(|p| &*p.name != "threshold");
            if let Some(t) = threshold {
                state
                    .materials
                    .get_mut(&material)
                    .unwrap()
                    .params
                    .push(Param {
                        name: "threshold".into(),
                        ty: VariantType::Float,
                        value: ParamValue::Scalar(t),
                    });
            }
            if instance {
                let params = state.materials[&material]
                    .params
                    .iter()
                    .filter(|p| &*p.name == "threshold")
                    .cloned()
                    .collect::<Vec<_>>();
                state
                    .materials
                    .get_mut(&material)
                    .unwrap()
                    .params
                    .retain(|p| &*p.name != "threshold");
                for id in state.items.keys().copied().collect::<Vec<_>>() {
                    state.items.get_mut(&id).unwrap().instance_params = params.clone();
                }
            }
            let d = TxDelta {
                full: next == 1,
                materials_upserted: vec![material],
                items_upserted: if instance {
                    state.items.keys().copied().collect()
                } else {
                    Vec::new()
                },
                ..TxDelta::default()
            };
            a.prepare(&state, &d);
            register_synthetic_programs(&mut a, &state, &payloads, &mut next, None).unwrap();
            a.apply(&state, &d, &payloads);
            assert!(!a.assembled_draws().is_empty(), "fixture must draw");
            assert_eq!(!a.list.draws.is_empty(), live, "threshold {threshold:?}");
            a.list.consumed();
        }
        assert_eq!(next, 2, "uniform updates reuse the registered program");
    }
}
