//! `rs-core-check fill`: per-pass fill accounting of the applier's packed list over a recording.

use super::{synthetic_meta, usage, Args};
use render_stream_core::validate::{Accepted, Options, Validator};
use render_stream_core::wire;
use serde_json::{json, Value as J};
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

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
/// and `noop_draws`, the draws among them that change no pixel at all.
/// `--damage <file>` also compares every transaction's draws with the previous one's
/// (`fill::signature`, `fill::damage`) and writes a summary: how many transactions changed
/// nothing, the damaged area's distribution, and the fill a redraw scissored to the damage
/// rectangle would cost.
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
        let mut prev_sig: Option<Vec<fill::DrawSig>> = None;
        let mut n = 0usize;
        // Damage summary accumulators.
        let (mut txs, mut unchanged) = (0u64, 0u64);
        let mut frac_rect: Vec<f64> = Vec::new();
        let mut frac_cells: Vec<f64> = Vec::new();
        let mut full_total: Vec<f64> = Vec::new();
        let mut clip_total: Vec<f64> = Vec::new();
        let mut changed_draws: Vec<u32> = Vec::new();
        // The same with TIME-reading programs held still, and the changed draws covering most of
        // the target (which alone make the damage rectangle the whole target).
        let mut prev_sig_still: Option<Vec<fill::DrawSig>> = None;
        let mut frac_rect_still: Vec<f64> = Vec::new();
        let mut big_changed: Vec<f64> = Vec::new();
        let mut big_names: HashMap<String, u64> = HashMap::new();
        for span in &spans[1..] {
            match v.accept(span.bytes(&data), span.offset)? {
                Accepted::Resource { hash } => {
                    if let Some(b) = v.inline_payload(&hash) {
                        payloads.provide(b, &hash, version, true)?;
                    }
                }
                Accepted::End
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
                    let (mut screen_slots, mut time_slots) =
                        (vec![false; slots], vec![false; slots]);
                    for k in 0..slots {
                        if let Some(key) = a.binding_key(k as u32) {
                            if let Some(&(sc, t)) = shader_use.get(&key.hash) {
                                screen_slots[k] = sc;
                                time_slots[k] = t;
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
                        let sig = fill::signature(&a.list, &revisions, &time_slots);
                        if let Some(prev) = prev_sig.as_ref() {
                            let (w, h) = (a.list.target.width, a.list.target.height);
                            let d = fill::damage(prev, &sig, w, h, 32);
                            let screen = f64::from(w) * f64::from(h);
                            txs += 1;
                            changed_draws.push(d.changed);
                            if d.changed == 0 {
                                unchanged += 1;
                                frac_rect.push(0.0);
                                frac_cells.push(0.0);
                                clip_total.push(0.0);
                            } else {
                                let r = d.rect.unwrap_or([0, 0, 0, 0]);
                                frac_rect.push(f64::from(r[2]) * f64::from(r[3]) / screen);
                                frac_cells.push(d.cells_px / screen);
                                let clipped = fill::account(
                                    &a.list,
                                    &FillOptions {
                                        clip: Some(r),
                                        cell: 16,
                                        ..opts.clone()
                                    },
                                );
                                clip_total.push(clipped.total() / screen);
                            }
                            full_total.push(
                                fill::account(
                                    &a.list,
                                    &FillOptions {
                                        cell: 16,
                                        ..opts.clone()
                                    },
                                )
                                .total()
                                    / screen,
                            );
                        }
                        let still = fill::signature(&a.list, &revisions, &[]);
                        if let (Some(prev), Some(prev_full)) =
                            (prev_sig_still.as_ref(), prev_sig.as_ref())
                        {
                            let (w, h) = (a.list.target.width, a.list.target.height);
                            let screen = f64::from(w) * f64::from(h);
                            let d = fill::damage(prev, &still, w, h, 32);
                            let r = d.rect.unwrap_or([0, 0, 0, 0]);
                            frac_rect_still.push(f64::from(r[2]) * f64::from(r[3]) / screen);
                            // Big changed draws of the real signature, by paint index.
                            let mut count: HashMap<u64, i32> = HashMap::new();
                            for x in prev_full {
                                *count.entry(x.hash).or_default() += 1;
                            }
                            let mut big = 0.0;
                            for (k, x) in sig.iter().enumerate() {
                                let n = count.entry(x.hash).or_default();
                                if *n > 0 {
                                    *n -= 1;
                                    continue;
                                }
                                let b = x.bounds;
                                let area = f64::from((b[2] - b[0]).max(0.0))
                                    * f64::from((b[3] - b[1]).max(0.0));
                                if area >= 0.5 * screen {
                                    big += 1.0;
                                    *big_names.entry(format!("sig#{k}")).or_default() += 1;
                                }
                            }
                            big_changed.push(big);
                        }
                        prev_sig_still = Some(still);
                        prev_sig = Some(sig);
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
                                one.instanced.retain(|_| false);
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
                    a.list.consumed();
                }
            }
        }
        if let Some(p) = damage_out.as_ref() {
            let q = |v: &mut Vec<f64>, f: f64| -> f64 {
                if v.is_empty() {
                    return 0.0;
                }
                v.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
                let x = v[((v.len() as f64 * f) as usize).min(v.len() - 1)];
                (x * 1000.0).round() / 1000.0
            };
            let mean = |v: &[f64]| -> f64 {
                if v.is_empty() {
                    0.0
                } else {
                    (v.iter().sum::<f64>() / v.len() as f64 * 1000.0).round() / 1000.0
                }
            };
            let mut cd: Vec<f64> = changed_draws.iter().map(|&c| f64::from(c)).collect();
            let mut big_v: Vec<(&String, &u64)> = big_names.iter().collect();
            big_v.sort_by(|a, b| b.1.cmp(a.1));
            let big_top: Vec<J> = big_v
                .into_iter()
                .take(12)
                .map(|(k, n)| json!([k, n]))
                .collect();
            let summary = json!({
                "transactions": txs, "unchanged": unchanged,
                "changed_draws": {"mean": mean(&cd), "p50": q(&mut cd, 0.5), "p95": q(&mut cd, 0.95)},
                "damage_rect_screens": {"mean": mean(&frac_rect), "p50": q(&mut frac_rect, 0.5), "p95": q(&mut frac_rect, 0.95)},
                "damage_cells_screens": {"mean": mean(&frac_cells), "p50": q(&mut frac_cells, 0.5), "p95": q(&mut frac_cells, 0.95)},
                "fill_full_screens": {"mean": mean(&full_total), "p50": q(&mut full_total, 0.5)},
                "fill_damage_rect_screens": {"mean": mean(&clip_total), "p50": q(&mut clip_total, 0.5), "p95": q(&mut clip_total, 0.95)},
                "damage_rect_screens_time_still": {"mean": mean(&frac_rect_still), "p50": q(&mut frac_rect_still, 0.5), "p95": q(&mut frac_rect_still, 0.95)},
                "big_changed_per_tx": mean(&big_changed),
                "big_changed_by_paint_index": big_top,
            });
            std::fs::write(p, format!("{summary:#}\n"))
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
        let mut meta = synthetic_meta(state, sid, &hash);
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
        // A final alpha that is a uniform's multiple: the uniform declared as the code declares
        // it when no material sets it (unset: its default), so its draws are what a client's are.
        let alpha = render_stream_core::apply::programs::alpha_uniform(&code);
        if let Some(a) = &alpha {
            let uniforms = meta["uniforms"].as_array_mut().expect("synthetic uniforms");
            if !uniforms.iter().any(|u| u["name"] == *a.name) {
                let n = usize::from(a.components);
                let mut unset = vec![0.0; n];
                if let Some(d) = a.default {
                    unset[0] = d;
                }
                let ty = ["float", "vec2", "vec3", "vec4"][n - 1];
                uniforms.push(json!({"name": &*a.name, "type": ty, "components": n,
                    "instance": a.instance, "integer": false, "unset": unset}));
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
