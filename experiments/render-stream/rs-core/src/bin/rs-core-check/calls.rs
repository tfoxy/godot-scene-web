//! Offline call planning. GL predictions describe a cold-cache root-list draw walk only:
//! drawElements excludes instanced calls (reported separately), texture/sampler binds use the
//! executor's per-unit cache and sampler normalization, and useProgram keys the compiled program,
//! not the binding slot. Screen operations, depth prepasses, uploads, target setup, presentation,
//! surface passes and unknown shader sampler declarations are outside these estimates.
//! Predictions always use K=1, including when `--slots 4` also reports the slot plan. Framebuffer
//! binds estimate target/back-buffer transitions, assuming both exist. Every texture is known and
//! every binding compiles, using the same synthetic shader metadata as `fill`.
use super::{fill_cmd::register_synthetic_programs, usage, Args};
use gsw_canvas_draw_list::{
    plan::{plan_calls_with_options, plan_calls_with_slots, BreakCounts, Call, PlanOptions},
    *,
};
use render_stream_core::{
    apply::{geom, payloads::PayloadStore, Applier, Viewport},
    validate::{Accepted, Options, Validator},
    wire,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::ExitCode,
};

pub(crate) fn histogram(b: &BreakCounts) -> Value {
    json!({"texture":b.texture,"sampler":b.sampler,"blend":b.blend,"program":b.program,
        "program_equal_bindings":b.program_equal_bindings,"msdf_flag":b.msdf_flag,
        "msdf_params":b.msdf_params,"scissor_flag":b.scissor_flag,"scissor_rect":b.scissor_rect,
        "back_buffer_group_flags":b.back_buffer_group_flags,"other_flags":b.other_flags,
        "instanced":b.instanced,"screen_ops":b.screen_ops,"index_gap":b.index_gap,
        "depth_level":b.depth_level,"group_cells":b.group_cells,"undrawable":b.undrawable})
}

fn sampler(bits: u32) -> u32 {
    let wrap = (bits & Sampler::WRAP_MASK) >> Sampler::WRAP_SHIFT;
    (if wrap <= 2 { wrap } else { 0 }) * 2 + (bits & Sampler::LINEAR)
}

fn predict(list: &DrawList, calls: &[Call]) -> Value {
    let (mut texture, mut filter, mut program, mut framebuffer) = (None, None, None, None);
    let (mut textures, mut samplers, mut programs, mut framebuffers, mut draws, mut instanced) =
        (0, 0, 0, 0, 0, 0);
    // Sampler uniforms occupy units distinct from the draw texture. Declarations are estimated
    // from supplied binding samplers; the native synthetic program has no linked GL reflection.
    let mut units = std::collections::HashMap::new();
    for c in calls {
        let d = &list.draws[c.draw as usize];
        let t = &list.draws[c.texture_draw as usize];
        let tex = if t.flags & DRAW_UNTEXTURED != 0 {
            WHITE_TEXTURE
        } else {
            t.texture
        };
        if texture != Some(tex) {
            textures += 1;
            texture = Some(tex);
        }
        if tex != WHITE_TEXTURE && filter != Some(sampler(t.sampler)) {
            samplers += 1;
            filter = Some(sampler(t.sampler));
        }
        let p = if d.program != BUILTIN_PROGRAM {
            (
                3,
                list.bindings
                    .get((d.program - 1) as usize)
                    .map_or(d.program, |b| b.program),
            )
        } else if d.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE) != 0 {
            (2, 0)
        } else if d.flags & DRAW_MSDF != 0 {
            (1, 0)
        } else {
            (0, 0)
        };
        if program != Some(p) {
            programs += 1;
            program = Some(p);
        }
        let fb = d.flags & DRAW_TO_BACK_BUFFER != 0;
        if framebuffer != Some(fb) {
            framebuffers += 1;
            framebuffer = Some(fb);
        }
        if d.flags & DRAW_INSTANCED != 0 {
            instanced += 1;
        } else {
            draws += 1;
        }
        if d.program != 0 {
            if let Some(b) = list.bindings.get((d.program - 1) as usize) {
                for (i, s) in b.samplers.iter().enumerate() {
                    // Screen reads use a fixed sampler, regardless of binding hints; draws
                    // into the back buffer read white with sampler 0 instead.
                    let pair = if s.texture == SCREEN_TEXTURE {
                        if fb {
                            (WHITE_TEXTURE, 0)
                        } else {
                            (SCREEN_TEXTURE, 0)
                        }
                    } else {
                        (s.texture, sampler(s.sampler))
                    };
                    if units.insert(i, pair) != Some(pair) {
                        textures += 1;
                        samplers += 1;
                    }
                }
            }
        } else if d.flags & (DRAW_GROUP_CLIP | DRAW_GROUP_COMPOSITE) != 0 {
            if units.insert(usize::MAX, (SCREEN_TEXTURE, 0)) != Some((SCREEN_TEXTURE, 0)) {
                textures += 1;
                samplers += 1;
            }
        }
    }
    json!({"drawElements":draws,"drawElementsInstanced":instanced,"texture_binds":textures,
        "sampler_binds":samplers,"useProgram":programs,"bindFramebuffer":framebuffers,"estimate":true})
}

/// `calls <recording> [--store dir] [--seqs a,b] [--every N] [--slots 1|4]`.
/// Applies every transaction with client cover/depth/group-cell walks enabled. Sampling only
/// controls printed rows; planner state is advanced on every transaction, including unprinted ones.
pub(crate) fn cmd(args: &Args) -> ExitCode {
    let Some(path) = args.positional.first() else {
        return usage();
    };
    let slots = match args.get("slots").unwrap_or("1") {
        "1" => 1,
        "4" => 4,
        _ => {
            eprintln!("calls: --slots must be 1 or 4");
            return ExitCode::FAILURE;
        }
    };
    let every = match args.get("every").unwrap_or("1").parse::<usize>() {
        Ok(n) if n > 0 => n,
        _ => {
            eprintln!("calls: --every must be positive");
            return ExitCode::FAILURE;
        }
    };
    let seqs = match args.get("seqs") {
        Some(s) => match s
            .split(',')
            .map(|x| x.trim().parse::<i64>())
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(v) => Some(v),
            Err(_) => {
                eprintln!("calls: invalid --seqs");
                return ExitCode::FAILURE;
            }
        },
        None => None,
    };
    let store = args.get("store").map(PathBuf::from);
    let run = || -> Result<(), wire::Error> {
        let io = |e: std::io::Error| wire::Error::new("io", e.to_string());
        let mut data = std::fs::read(path).map_err(io)?;
        if data.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
            let mut decoded = Vec::new();
            ruzstd::decoding::StreamingDecoder::new(&data[..])
                .map_err(|e| wire::Error::new("zstd", e.to_string()))?
                .read_to_end(&mut decoded)
                .map_err(io)?;
            data = decoded;
        }
        let version = wire::version_of_magic(&data)
            .ok_or_else(|| wire::Error::new("bad-magic", "not a render-stream recording"))?;
        let spans = wire::split_records(&data, version)?;
        let first = spans
            .first()
            .ok_or_else(|| wire::Error::new("empty", "no session"))?;
        let mut v = Validator::new(first.bytes(&data), first.offset, Options::new(version))?;
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
            format: Format::Rgb10A2,
        });
        a.cover_walk = true;
        a.set_cover_noops(true);
        a.set_cover_tiles(true);
        a.set_group_scissor(true);
        a.set_group_merge(true);
        a.set_group_cells(true);
        let mut payloads = PayloadStore::default();
        let mut need = Vec::new();
        let mut next = 1;
        let mut calls = Vec::new();
        let mut single_calls = Vec::new();
        let mut stream = Vec::new();
        let mut dirty = Vec::new();
        let mut n = 0usize;
        let mut out = std::io::stdout().lock();
        for span in &spans[1..] {
            match v.accept(span.bytes(&data), span.offset)? {
                Accepted::Resource { hash } => {
                    if let Some(b) = v.inline_payload(&hash) {
                        payloads.provide(b, &hash, version, true)?;
                    }
                }
                Accepted::Transaction => {
                    payloads.accept_transaction(&v, span.bytes(&data))?;
                    a.prepare(v.state(), v.delta());
                    a.needed(v.state(), v.delta(), &payloads, &mut need);
                    for h in &need {
                        if let Some(dir) = &store {
                            for ext in ["grt", "grm", "grp"] {
                                if let Ok(b) = std::fs::read(
                                    dir.join("sha256").join(format!("{}.{ext}", h.to_hex())),
                                ) {
                                    payloads.provide(&b, h, version, true)?;
                                    break;
                                }
                            }
                        }
                    }
                    register_synthetic_programs(&mut a, v.state(), &payloads, &mut next, None)?;
                    a.apply(v.state(), v.delta(), &payloads);
                    let counts = plan_calls_with_slots(
                        &a.list,
                        PlanOptions {
                            texture_slots: slots,
                        },
                        |_| true,
                        |_| true,
                        &mut calls,
                        &mut stream,
                        &mut dirty,
                    );
                    let k1 = plan_calls_with_options(
                        &a.list,
                        PlanOptions::default(),
                        |_| true,
                        |_| true,
                        &mut single_calls,
                    );
                    if k1.skipped == 0 && single_calls.len() != a.list.merged_draw_count() {
                        return Err(wire::Error::new(
                            "k1-mismatch",
                            "planner differs from merged_draw_count",
                        ));
                    }
                    let seq = v.state().seq;
                    if seqs
                        .as_ref()
                        .map_or(n.is_multiple_of(every), |s| s.contains(&seq))
                    {
                        let row = json!({"seq":seq,"draws":a.list.draws.len(),"calls":calls.len(),"merged":counts.merged,"skipped":counts.skipped,"breaks":histogram(&counts.breaks),"predicted_gl":predict(&a.list,&single_calls),"texture_slots":slots, "baseline_calls":single_calls.len(), "slot_calls":calls.len(), "slot_bytes_changed":dirty.iter().map(|r|r.len()).sum::<usize>(), "slot_fallbacks":counts.slot_fallbacks});
                        writeln!(out, "{row}").map_err(io)?;
                    }
                    n += 1;
                    a.list.consumed();
                }
                _ => {}
            }
        }
        Ok(())
    };
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("calls: {}: {}", e.code, e.detail);
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn predicts_screen_sampler_target_transitions() {
        let list = DrawList {
            indices: vec![0; 9],
            draws: [0, DRAW_TO_BACK_BUFFER, 0]
                .into_iter()
                .enumerate()
                .map(|(i, flags)| Draw {
                    first_index: i as u32 * 3,
                    index_count: 3,
                    texture: 7,
                    program: 1,
                    flags,
                    ..Default::default()
                })
                .collect(),
            bindings: vec![Binding {
                program: 12,
                samplers: vec![SamplerUniform {
                    name: "SCREEN_TEXTURE".into(),
                    texture: SCREEN_TEXTURE,
                    sampler: 0,
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut calls = Vec::new();
        plan_calls_with_options(
            &list,
            PlanOptions::default(),
            |_| true,
            |_| true,
            &mut calls,
        );
        let p = predict(&list, &calls);
        assert_eq!(p["texture_binds"], 4);
        assert_eq!(p["sampler_binds"], 4);
        assert_eq!(p["useProgram"], 1);
        assert_eq!(p["bindFramebuffer"], 3);
        assert_eq!(p["drawElements"], 3);
    }

    #[test]
    fn predicts_fixed_screen_sampler_despite_binding_hints() {
        let list = DrawList {
            indices: vec![0; 9],
            draws: (0..3)
                .map(|i| Draw {
                    first_index: i * 3,
                    index_count: 3,
                    texture: 7,
                    program: i + 1,
                    ..Default::default()
                })
                .collect(),
            bindings: [0, Sampler::LINEAR, Sampler::REPEAT]
                .into_iter()
                .map(|bits| Binding {
                    program: 12,
                    samplers: vec![SamplerUniform {
                        name: "SCREEN_TEXTURE".into(),
                        texture: SCREEN_TEXTURE,
                        sampler: bits,
                    }],
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        let mut calls = Vec::new();
        plan_calls_with_options(
            &list,
            PlanOptions::default(),
            |_| true,
            |_| true,
            &mut calls,
        );
        let p = predict(&list, &calls);
        assert_eq!(p["texture_binds"], 2);
        assert_eq!(p["sampler_binds"], 2);
        assert_eq!(p["useProgram"], 1);
        assert_eq!(p["drawElements"], 3);
    }

    #[test]
    fn predicts_compiled_program_and_draw_unit_cache() {
        let list = DrawList {
            indices: vec![0; 9],
            draws: vec![
                Draw {
                    index_count: 3,
                    texture: 7,
                    program: 1,
                    ..Default::default()
                },
                Draw {
                    first_index: 3,
                    index_count: 3,
                    texture: 7,
                    program: 2,
                    ..Default::default()
                },
                Draw {
                    first_index: 6,
                    index_count: 3,
                    flags: DRAW_UNTEXTURED,
                    ..Default::default()
                },
            ],
            bindings: vec![
                Binding {
                    program: 12,
                    ..Default::default()
                };
                2
            ],
            ..Default::default()
        };
        let mut calls = Vec::new();
        plan_calls_with_options(
            &list,
            PlanOptions::default(),
            |_| true,
            |_| true,
            &mut calls,
        );
        let p = predict(&list, &calls);
        assert_eq!(p["useProgram"], 2);
        assert_eq!(p["texture_binds"], 2);
        assert_eq!(p["sampler_binds"], 1);
        assert_eq!(p["drawElements"], 3);
    }
}
