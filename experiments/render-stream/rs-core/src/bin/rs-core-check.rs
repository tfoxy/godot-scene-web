//! `rs-core-check` (gate7-design.md Q14a/Q14d): the native front end of render-stream-core's decoder.
//!
//!   rs-core-check goldens [--dir experiments/render-stream/protocol] [--only 6]
//!                         [--sabotage skip-payload-hash]
//!   rs-core-check diff --inputs <inputs.json> [--out <dir>] [--dump <input>:<seq>]
//!   rs-core-check bench (<recording> | --inputs <inputs.json>) [--repeats N] [--digest inline|deferred]
//!   rs-core-check validate <recording>... [--version 2..7] [--recover]
//!   rs-core-check apply-bench <recording> --store <dir> [--repeats N]
//!   rs-core-check scissors <recording> [--store <dir>]
//!   rs-core-check state-dump <recording> --seqs 8,18,... --out <dir>
//!
//! `goldens` runs golden-2 ... golden-7 (exits non-zero on any failing check). `diff` feeds every
//! record of every input through the validator and writes one JSONL line per record (record sha256,
//! and per transaction its seq, the sha256 of its canonical resolved JSON and its unsupported list),
//! the native side of `scripts/test/self-test-rs-core.ts`. `bench` times `accept` per record.
//! `validate` prints each recording's verdict (`ok`, or its first error), one tab-separated line
//! per file; the version comes from `--version` or the file's magic. `--recover` instead skips every
//! rejected record and keeps going (the validator must leave its state untouched by a failed
//! accept), printing the rejected and accepted record counts and a digest chaining the canonical
//! JSON of every accepted transaction: a recording with a rejected record inserted must chain like
//! the recording without it.

use render_stream_core::canon;
use render_stream_core::goldens::{self, GoldenOptions};
use render_stream_core::validate::{Accepted, DigestPolicy, Options, Validator};
use render_stream_core::wire;
use serde_json::{json, Value as J};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

fn usage() -> ExitCode {
    eprintln!(
        "usage:\n  rs-core-check goldens [--dir <protocol dir>] [--only <2..7>] [--sabotage skip-payload-hash]\n  \
         rs-core-check diff --inputs <inputs.json> [--out <dir>] [--dump <input>:<seq>]\n  \
         rs-core-check bench (<recording> | --inputs <inputs.json>) [--repeats N] [--digest inline|deferred]\n  \
         rs-core-check validate <recording>... [--version 2..6]"
    );
    ExitCode::from(2)
}

struct Args {
    positional: Vec<String>,
    flags: Vec<(String, String)>,
}

impl Args {
    fn parse(raw: &[String]) -> Option<Args> {
        let mut positional = Vec::new();
        let mut flags = Vec::new();
        let mut i = 0;
        while i < raw.len() {
            let a = &raw[i];
            if let Some(name) = a.strip_prefix("--") {
                if let Some((k, v)) = name.split_once('=') {
                    flags.push((k.to_string(), v.to_string()));
                } else if name == "recover" {
                    flags.push((name.to_string(), "1".to_string()));
                } else {
                    let v = raw.get(i + 1)?.clone();
                    flags.push((name.to_string(), v));
                    i += 1;
                }
            } else {
                positional.push(a.clone());
            }
            i += 1;
        }
        Some(Args { positional, flags })
    }
    fn get(&self, k: &str) -> Option<&str> {
        self.flags
            .iter()
            .rev()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
    }
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = raw.first().cloned() else {
        return usage();
    };
    let Some(args) = Args::parse(&raw[1..]) else {
        return usage();
    };
    match cmd.as_str() {
        "goldens" => cmd_goldens(&args),
        "diff" => cmd_diff(&args),
        "bench" => cmd_bench(&args),
        "apply-bench" => cmd_apply_bench(&args),
        "scissors" => cmd_scissors(&args),
        "state-dump" => cmd_state_dump(&args),
        "validate" => cmd_validate(&args),
        _ => usage(),
    }
}

fn cmd_goldens(args: &Args) -> ExitCode {
    let dir = PathBuf::from(
        args.get("dir")
            .unwrap_or("experiments/render-stream/protocol"),
    );
    let only = match args.get("only").map(|s| s.parse::<u8>()) {
        None => None,
        Some(Ok(v)) if (2..=7).contains(&v) => Some(v),
        Some(_) => return usage(),
    };
    let opts = match args.get("sabotage") {
        None => GoldenOptions::default(),
        Some("skip-payload-hash") => GoldenOptions {
            verify_payload_hashes: false,
        },
        Some(_) => return usage(),
    };
    let read = |rel: &str| std::fs::read(dir.join(rel)).ok();
    let checks = goldens::run_all(&read, only, opts);
    let mut failed = 0;
    let mut per_dir: Vec<(String, usize, usize)> = Vec::new();
    for c in &checks {
        let group = c
            .name
            .split(':')
            .next()
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("")
            .to_string();
        let group = if group.starts_with("golden-") {
            group
        } else {
            "cross-version".into()
        };
        match per_dir.iter_mut().find(|(g, _, _)| *g == group) {
            Some(e) => {
                e.1 += c.ok as usize;
                e.2 += 1;
            }
            None => per_dir.push((group, c.ok as usize, 1)),
        }
        if c.ok {
            println!("[OK]   {}", c.name);
        } else {
            failed += 1;
            println!(
                "[FAIL] {}{}",
                c.name,
                if c.detail.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", c.detail)
                }
            );
        }
    }
    println!();
    for (g, ok, n) in &per_dir {
        println!("{g}: {ok}/{n} checks passed");
    }
    if opts.verify_payload_hashes {
        println!(
            "rs-core-check goldens: {}",
            if failed == 0 {
                "all checks passed".to_string()
            } else {
                format!("{failed} check(s) FAILED")
            }
        );
    } else {
        println!("rs-core-check goldens (sabotage skip-payload-hash): {failed} check(s) FAILED");
    }
    if failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

struct Input {
    name: String,
    recording: PathBuf,
}

fn read_inputs(path: &str) -> Result<Vec<Input>, String> {
    let text = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let v: J = serde_json::from_slice(&text).map_err(|e| format!("{path}: {e}"))?;
    if v.get("schema").and_then(|s| s.as_str()) != Some("render-stream-gate7-bench-inputs/1") {
        return Err(format!(
            "{path}: schema is not render-stream-gate7-bench-inputs/1"
        ));
    }
    let base = Path::new(path).parent().unwrap_or(Path::new("."));
    let list = v
        .get("inputs")
        .and_then(|i| i.as_array())
        .ok_or_else(|| format!("{path}: no inputs[]"))?;
    list.iter()
        .map(|i| {
            let name = i
                .get("name")
                .and_then(|n| n.as_str())
                .ok_or("an input has no name")?
                .to_string();
            let rec = i
                .get("recording")
                .and_then(|n| n.as_str())
                .ok_or("an input has no recording")?;
            Ok(Input {
                name,
                recording: base.join(rec),
            })
        })
        .collect()
}

fn record_type(r: &Accepted) -> &'static str {
    match r {
        Accepted::Resource { .. } => "resource",
        Accepted::Transaction => "transaction",
        Accepted::End => "end",
    }
}

fn cmd_diff(args: &Args) -> ExitCode {
    let Some(inputs_path) = args.get("inputs") else {
        return usage();
    };
    let inputs = match read_inputs(inputs_path) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("rs-core-check diff: {e}");
            return ExitCode::from(2);
        }
    };
    let dump = args
        .get("dump")
        .and_then(|d| d.rsplit_once(':'))
        .map(|(n, s)| (n.to_string(), s.parse::<i64>().unwrap_or(-1)));
    let out_dir = PathBuf::from(
        args.get("out")
            .unwrap_or("artifacts/render-stream/gate7/g7x/rs-core-diff"),
    );
    if dump.is_none() {
        if let Err(e) = std::fs::create_dir_all(&out_dir) {
            eprintln!("rs-core-check diff: {}: {e}", out_dir.display());
            return ExitCode::from(2);
        }
    }
    let mut failed = false;
    for input in &inputs {
        if let Some((name, _)) = &dump {
            if *name != input.name {
                continue;
            }
        }
        let data = match std::fs::read(&input.recording) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("rs-core-check diff: {}: {e}", input.recording.display());
                failed = true;
                continue;
            }
        };
        let Some(version) = wire::version_of_magic(&data) else {
            eprintln!(
                "rs-core-check diff: {}: not a render-stream/2..6 recording",
                input.recording.display()
            );
            failed = true;
            continue;
        };
        let mut lines: Vec<u8> = Vec::new();
        let mut transactions = 0usize;
        let mut error: Option<String> = None;
        let mut canon_buf = Vec::new();
        let result = (|| -> Result<(), wire::Error> {
            let records = wire::split_records(&data, version)?;
            let first = records
                .first()
                .ok_or_else(|| wire::Error::new("missing-session", "no records"))?;
            let opts = Options {
                version,
                digest: DigestPolicy::Inline,
                verify_payload_hashes: true,
            };
            let session_bytes = first.bytes(&data);
            let mut v = Validator::new(session_bytes, first.offset, opts)?;
            let line = json!({"index": 0, "offset": first.offset, "type": "session", "sha256": wire::record_sha256(session_bytes).to_hex()});
            lines.extend_from_slice(line.to_string().as_bytes());
            lines.push(b'\n');
            for (i, r) in records.iter().enumerate().skip(1) {
                let bytes = r.bytes(&data);
                let accepted = v.accept(bytes, r.offset)?;
                let digest = v.record_digests()[i]
                    .map(|h| h.to_hex())
                    .unwrap_or_default();
                let mut line = json!({"index": i, "offset": r.offset, "type": record_type(&accepted), "sha256": digest});
                if accepted == Accepted::Transaction {
                    transactions += 1;
                    let st = v.state();
                    canon_buf.clear();
                    canon::write_transaction(&mut canon_buf, st);
                    if let Some((_, seq)) = &dump {
                        if *seq == st.seq {
                            println!("{}", String::from_utf8_lossy(&canon_buf));
                        }
                    }
                    let unsupported: Vec<J> = st
                        .unsupported
                        .iter()
                        .map(|u| json!({"op": &*u.op, "item": u.item, "reason": u.reason}))
                        .collect();
                    line["seq"] = json!(st.seq);
                    line["state_sha256"] = json!(wire::sha256(&canon_buf).to_hex());
                    line["unsupported"] = J::Array(unsupported);
                }
                lines.extend_from_slice(line.to_string().as_bytes());
                lines.push(b'\n');
            }
            v.finish()
        })();
        if let Err(e) = result {
            error = Some(e.to_string());
            let line = json!({"error": e.to_string()});
            lines.extend_from_slice(line.to_string().as_bytes());
            lines.push(b'\n');
            failed = true;
        }
        if dump.is_none() {
            let path = out_dir.join(format!("{}.jsonl", input.name));
            if let Err(e) = std::fs::write(&path, &lines) {
                eprintln!("rs-core-check diff: {}: {e}", path.display());
                failed = true;
            }
            println!(
                "{}: version {version}, {} records, {transactions} transactions{} -> {}",
                input.name,
                lines.iter().filter(|&&b| b == b'\n').count(),
                error.map(|e| format!(", ERROR {e}")).unwrap_or_default(),
                path.display()
            );
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let rank = (p / 100.0 * (sorted.len() - 1) as f64).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

fn bench_one(
    name: &str,
    data: &[u8],
    repeats: usize,
    digest: DigestPolicy,
) -> Result<(), wire::Error> {
    let version = wire::version_of_magic(data)
        .ok_or_else(|| wire::Error::new("bad-magic", "not a render-stream/2..6 recording"))?;
    let records = wire::split_records(data, version)?;
    let first = records
        .first()
        .ok_or_else(|| wire::Error::new("missing-session", "no records"))?;
    let mut full: Vec<f64> = Vec::new();
    let mut patch: Vec<f64> = Vec::new();
    let mut other: Vec<f64> = Vec::new();
    let mut pass_ms: Vec<f64> = Vec::new();
    for _ in 0..repeats {
        let pass = Instant::now();
        let opts = Options {
            version,
            digest,
            verify_payload_hashes: true,
        };
        let mut v = Validator::new(first.bytes(data), first.offset, opts)?;
        for r in &records[1..] {
            let bytes = r.bytes(data);
            let t = Instant::now();
            let a = v.accept(bytes, r.offset)?;
            let us = t.elapsed().as_secs_f64() * 1e6;
            match a {
                Accepted::Transaction if v.delta().full => full.push(us),
                Accepted::Transaction => patch.push(us),
                _ => other.push(us),
            }
        }
        v.finish()?;
        pass_ms.push(pass.elapsed().as_secs_f64() * 1e3);
    }
    let summarize = |label: &str, v: &mut Vec<f64>| {
        if v.is_empty() {
            return;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "  {label:<12} n={:<6} p50 {:>9.1} us  p95 {:>9.1} us  max {:>9.1} us",
            v.len() / repeats.max(1),
            percentile(v, 50.0),
            percentile(v, 95.0),
            v.last().unwrap()
        );
    };
    let mut all: Vec<f64> = full.iter().chain(patch.iter()).copied().collect();
    pass_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "{name}: version {version}, {} bytes, {} records, digest {}, {repeats} repeat(s), pass median {:.2} ms",
        data.len(),
        records.len(),
        if digest == DigestPolicy::Inline { "inline" } else { "deferred" },
        percentile(&pass_ms, 50.0)
    );
    summarize("transactions", &mut all);
    summarize("full", &mut full);
    summarize("patch", &mut patch);
    summarize("other", &mut other);
    Ok(())
}

fn cmd_bench(args: &Args) -> ExitCode {
    let repeats = args
        .get("repeats")
        .map(|r| r.parse::<usize>().unwrap_or(5))
        .unwrap_or(5)
        .max(1);
    let digest = match args.get("digest").unwrap_or("deferred") {
        "inline" => DigestPolicy::Inline,
        "deferred" => DigestPolicy::Deferred,
        _ => return usage(),
    };
    let mut targets: Vec<(String, PathBuf)> = Vec::new();
    if let Some(inputs) = args.get("inputs") {
        match read_inputs(inputs) {
            Ok(list) => targets.extend(list.into_iter().map(|i| (i.name, i.recording))),
            Err(e) => {
                eprintln!("rs-core-check bench: {e}");
                return ExitCode::from(2);
            }
        }
    }
    for p in &args.positional {
        targets.push((p.clone(), PathBuf::from(p)));
    }
    if targets.is_empty() {
        return usage();
    }
    let mut failed = false;
    for (name, path) in targets {
        let data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("rs-core-check bench: {}: {e}", path.display());
                failed = true;
                continue;
            }
        };
        if let Err(e) = bench_one(&name, &data, repeats, digest) {
            eprintln!("rs-core-check bench: {name}: {e}");
            failed = true;
        }
        let _ = std::io::stdout().flush();
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn cmd_validate(args: &Args) -> ExitCode {
    let forced = match args.get("version").map(|v| v.parse::<u8>()) {
        None => None,
        Some(Ok(v)) if (2..=7).contains(&v) => Some(v),
        Some(_) => return usage(),
    };
    if args.positional.is_empty() {
        return usage();
    }
    let mut any_error = false;
    for path in &args.positional {
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(e) => {
                println!("{path}\tio-error\t{e}");
                any_error = true;
                continue;
            }
        };
        let version = forced
            .or_else(|| wire::version_of_magic(&data))
            .unwrap_or(6);
        if args.get("recover").is_some() {
            match recover_chain(&data, version) {
                Ok((rejected, accepted, chain)) => {
                    println!("{path}\trecover\t{rejected}\t{accepted}\t{chain}")
                }
                Err(e) => {
                    any_error = true;
                    println!("{path}\t{}\t{}", e.code, e.detail);
                }
            }
            continue;
        }
        match render_stream_core::validate::validate_recording(&data, Options::new(version)) {
            Ok(()) => println!("{path}\tok\t"),
            Err(e) => {
                any_error = true;
                println!("{path}\t{}\t{}", e.code, e.detail);
            }
        }
    }
    if any_error {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// `validate --recover`: (rejected records, accepted records, chained state digest).
fn recover_chain(data: &[u8], version: u8) -> Result<(usize, usize, String), wire::Error> {
    let records = wire::split_records(data, version)?;
    let first = records
        .first()
        .ok_or_else(|| wire::Error::new("missing-session", "no records"))?;
    let mut v = Validator::new(first.bytes(data), first.offset, Options::new(version))?;
    let (mut rejected, mut accepted) = (0usize, 0usize);
    let mut chain: Vec<u8> = Vec::new();
    let mut buf = Vec::new();
    for r in &records[1..] {
        match v.accept(r.bytes(data), r.offset) {
            Ok(Accepted::Transaction) => {
                accepted += 1;
                buf.clear();
                canon::write_transaction(&mut buf, v.state());
                chain.extend_from_slice(&wire::sha256(&buf).0);
                // The delta must name exactly what differs from the previous state (checked by
                // the full-state digest chain; the delta itself is the applier's contract).
            }
            Ok(_) => accepted += 1,
            Err(e) => {
                rejected += 1;
                if std::env::var_os("RS_CORE_RECOVER_VERBOSE").is_some() {
                    eprintln!("offset {}: {e}", r.offset);
                }
            }
        }
    }
    Ok((rejected, accepted, wire::sha256(&chain).to_hex()))
}

/// `apply-bench <recording> --store <dir>`: accept, provide (from the capture's store) and apply
/// every transaction natively (no GL), timing `Applier::apply` and counting why each structural
/// walk ran ([`render_stream_core::apply::Why`]). A diagnostic for the applier's paths.
fn cmd_apply_bench(args: &Args) -> ExitCode {
    use render_stream_core::apply::geom;
    use render_stream_core::apply::payloads::PayloadStore;
    use render_stream_core::apply::{Applier, Viewport, Why};
    let Some(path) = args.positional.first() else {
        return usage();
    };
    let store = args.get("store").map(PathBuf::from);
    let repeats = args
        .get("repeats")
        .and_then(|r| r.parse::<usize>().ok())
        .unwrap_or(3)
        .max(1);
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("rs-core-check apply-bench: {path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let run = || -> Result<(Vec<f64>, Vec<u32>), wire::Error> {
        let version = wire::version_of_magic(&data)
            .ok_or_else(|| wire::Error::new("bad-magic", "not a render-stream recording"))?;
        let spans = wire::split_records(&data, version)?;
        let mut v = Validator::new(
            spans[0].bytes(&data),
            spans[0].offset,
            Options::new(version),
        )?;
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
        let mut payloads = PayloadStore::default();
        let mut need = Vec::new();
        let (mut times, mut whys) = (Vec::new(), Vec::new());
        for span in &spans[1..] {
            match v.accept(span.bytes(&data), span.offset)? {
                Accepted::Resource { hash } => {
                    if let Some(b) = v.inline_payload(&hash) {
                        payloads.provide(b, &hash, version, true)?;
                    }
                }
                Accepted::End => {}
                Accepted::Transaction => {
                    a.prepare(v.state(), v.delta());
                    a.needed(v.state(), v.delta(), &payloads, &mut need);
                    for h in &need {
                        let dir = store.as_ref().ok_or_else(|| {
                            wire::Error::new("resource-unavailable", "no --store")
                        })?;
                        let mut bytes = None;
                        for ext in ["grt", "grm", "grp"] {
                            let p = dir.join("sha256").join(format!("{}.{ext}", h.to_hex()));
                            if let Ok(b) = std::fs::read(&p) {
                                bytes = Some(b);
                                break;
                            }
                        }
                        let b = bytes
                            .ok_or_else(|| wire::Error::new("resource-unavailable", h.to_hex()))?;
                        payloads.provide(&b, h, version, true)?;
                    }
                    let t = Instant::now();
                    let st = a.apply(v.state(), v.delta(), &payloads);
                    times.push(t.elapsed().as_secs_f64() * 1e6);
                    whys.push(st.why);
                    if st.why != 0 && std::env::var("RS_APPLY_BENCH_VERBOSE").is_ok() {
                        eprintln!(
                            "seq {} why {:#x} walk {:.1} us assemble {:.1} us total {:.1} us",
                            v.state().seq,
                            st.why,
                            st.walk_us,
                            st.assemble_us,
                            times.last().unwrap()
                        );
                    }
                    a.list.consumed();
                }
            }
        }
        Ok((times, whys))
    };
    let mut all = Vec::new();
    let mut whys = Vec::new();
    for _ in 0..repeats {
        match run() {
            Ok((t, w)) => {
                all.extend(t);
                whys = w;
            }
            Err(e) => {
                eprintln!("rs-core-check apply-bench: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    all.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| all[((p * all.len() as f64).ceil() as usize).clamp(1, all.len()) - 1];
    let walks = whys.iter().filter(|w| **w != 0).count();
    println!(
        "{path}: {} transactions, apply us p50 {:.1} p95 {:.1} max {:.1}; structural walks {walks}",
        whys.len(),
        pct(0.5),
        pct(0.95),
        all[all.len() - 1]
    );
    for (bit, name) in Why::NAMES.iter().enumerate() {
        let n = whys.iter().filter(|w| *w & (1 << bit) != 0).count();
        if n > 0 {
            println!("  why {name}: {n}");
        }
    }
    ExitCode::SUCCESS
}

/// `scissors <recording> [--store <dir>]` (gate7-design.md G7a `clip-parity`, Q14d "Lowering"):
/// replays every transaction through the applier (natively, no GL) and prints one JSON line per
/// transaction, `{"seq":n,"items":[[id,[x0,y0,x1,y1]|null],...]}`: every item the walk visited,
/// with the integer scissor it draws under (its own or its clip owner's, half-open) or null.
/// `scripts/lib/gate7-gsw-checks.ts` compares it with `clip-derive.ts` item by item.
fn cmd_scissors(args: &Args) -> ExitCode {
    use render_stream_core::apply::geom;
    use render_stream_core::apply::payloads::PayloadStore;
    use render_stream_core::apply::{Applier, Viewport};
    let Some(path) = args.positional.first() else {
        return usage();
    };
    let store = args.get("store").map(PathBuf::from);
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
        let s = v.session();
        let mut a = Applier::new(Viewport {
            width: s.viewport.logical_size[0].max(1) as u32,
            height: s.viewport.logical_size[1].max(1) as u32,
            clear: s.clear_color,
            global_xform: geom::IDENTITY,
            cull_mask: s.viewport.canvas_cull_mask as u32,
            format: gsw_canvas_draw_list::Format::Rgb10A2,
        });
        let mut payloads = PayloadStore::default();
        let mut need = Vec::new();
        let mut out = std::io::stdout().lock();
        for span in &spans[1..] {
            match v.accept(span.bytes(&data), span.offset)? {
                Accepted::Resource { hash } => {
                    if let Some(b) = v.inline_payload(&hash) {
                        payloads.provide(b, &hash, version, true)?;
                    }
                }
                Accepted::End => {}
                Accepted::Transaction => {
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
                    a.apply(v.state(), v.delta(), &payloads);
                    a.list.consumed();
                    let items: Vec<J> = a
                        .scissors()
                        .into_iter()
                        .map(|(id, r)| json!([id, r.map(|r| json!(r)).unwrap_or(J::Null)]))
                        .collect();
                    let line = json!({"seq": v.state().seq, "items": items});
                    let _ = writeln!(out, "{line}");
                }
            }
        }
        Ok(())
    };
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("rs-core-check scissors: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `state-dump <recording> --seqs a,b,... --out <dir>`: writes `<dir>/seq-<n>.json`, the resolved
/// state after transaction n exactly as the native receiver's `RS_RECEIVER_STATE_SEQS` dump spells
/// it (`canon::write_state_godot`); the GSW receiver's `state_dump()` is the same function.
fn cmd_state_dump(args: &Args) -> ExitCode {
    let (Some(path), Some(seqs), Some(out)) =
        (args.positional.first(), args.get("seqs"), args.get("out"))
    else {
        return usage();
    };
    let seqs: Vec<i64> = seqs
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let run = || -> Result<usize, wire::Error> {
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
        std::fs::create_dir_all(out).map_err(|e| wire::Error::new("out", e.to_string()))?;
        let mut n = 0;
        for span in &spans[1..] {
            if let Accepted::Transaction = v.accept(span.bytes(&data), span.offset)? {
                let seq = v.state().seq;
                if seqs.contains(&seq) {
                    let mut buf = Vec::new();
                    canon::write_state_godot(&mut buf, v.state());
                    buf.push(b'\n');
                    std::fs::write(Path::new(out).join(format!("seq-{seq}.json")), buf)
                        .map_err(|e| wire::Error::new("out", e.to_string()))?;
                    n += 1;
                }
            }
        }
        Ok(n)
    };
    match run() {
        Ok(n) => {
            println!("state-dump: {n} states");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("rs-core-check state-dump: {e}");
            ExitCode::FAILURE
        }
    }
}
