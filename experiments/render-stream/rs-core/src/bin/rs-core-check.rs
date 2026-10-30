//! `rs-core-check` (gate7-design.md Q14a/Q14d): the native front end of render-stream-core's decoder.
//!
//!   rs-core-check goldens [--dir experiments/render-stream/protocol] [--only 6]
//!                         [--sabotage skip-payload-hash|early-prune|no-predict-reset]
//!   rs-core-check transcode --to 12|13 [--stale] <in> <out>
//!   rs-core-check transcode --roundtrip <recording.rs12>...
//!   rs-core-check diff --inputs <inputs.json> [--out <dir>] [--dump <input>:<seq>]
//!   rs-core-check bench (<recording> | --inputs <inputs.json>) [--repeats N] [--digest inline|deferred|none]
//!   rs-core-check validate <recording>... [--version 2..8] [--recover]
//!   rs-core-check apply-bench <recording> --store <dir> [--repeats N]
//!   rs-core-check profile <recording> --store <dir> [--repeats N] [--digest inline|deferred] [--clock time|allocs]
//!   rs-core-check walk-diff <recording>... [--store <dir>] [--digests <file>]
//!   rs-core-check material-diff <recording>... [--store <dir>] [--sabotage mra-skip-changed|mra-skip-binding] [--baseline]
//!   rs-core-check scissors <recording> [--store <dir>]
//!   rs-core-check lowered <recording> --seqs 8,18,... [--store <dir>]
//!   rs-core-check state-dump <recording> --seqs 8,18,... --out <dir>
//!
//! `goldens` runs golden-2 ... golden-13 (exits non-zero on any failing check). `transcode` (W13a,
//! render-stream-13.md "Forms and transcode") converts a /12 recording to /13 or back, refusing an
//! invalid input with the decoder's error code; `--stale` is the encoder sabotage
//! `predict-stale`; `--roundtrip` checks /12 → /13 → /12 byte for byte and reports the sizes and
//! the predicted units by order. `diff` feeds every
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
use render_stream_core::coding::{self, LiveDecoder, Outcome};
use render_stream_core::goldens::{self, GoldenOptions};
use render_stream_core::validate::{Accepted, DigestPolicy, Options, Validator};
use render_stream_core::wire;
use serde_json::{json, Value as J};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

/// G7o3: the system allocator, counting allocations (`profile` reports them per transaction).
struct Counting;
static ALLOCATIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
unsafe impl std::alloc::GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: std::alloc::Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::alloc::System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: std::alloc::Layout) {
        std::alloc::System.dealloc(p, l)
    }
    unsafe fn alloc_zeroed(&self, l: std::alloc::Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::alloc::System.alloc_zeroed(l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: std::alloc::Layout, n: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::alloc::System.realloc(p, l, n)
    }
}
#[global_allocator]
static GLOBAL: Counting = Counting;

fn usage() -> ExitCode {
    eprintln!(
        "usage:\n  rs-core-check goldens [--dir <protocol dir>] [--only <2..13>] [--sabotage skip-payload-hash|early-prune|no-predict-reset]\n  \
         rs-core-check transcode --to 12|13 [--stale] <in> <out>\n  \
         rs-core-check transcode --roundtrip <recording.rs12>...\n  \
         rs-core-check diff --inputs <inputs.json> [--out <dir>] [--dump <input>:<seq>]\n  \
         rs-core-check bench (<recording> | --inputs <inputs.json>) [--repeats N] [--digest inline|deferred|none]\n  \
         rs-core-check validate <recording>... [--version 2..8]\n  \
         rs-core-check material-diff <recording>... [--store <dir>] [--sabotage mra-skip-changed|mra-skip-binding] [--baseline]\n  \
         rs-core-check client-diff <recording>... [--store <dir>] [--sabotage ph2-skip-body-digest|ph2-skip-dep-texture|ph2-park-stale|ph2-skip-material-textures]\n  \
         rs-core-check live-decode <coded> [--expect <recording>] [--bases keep|none] [--repeats N] [--stats <jsonl>] [--sabotage drop-base|wrong-prefix]"
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
                } else if name == "recover"
                    || name == "stale"
                    || name == "roundtrip"
                    || name == "baseline"
                {
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
        "profile" => cmd_profile(&args),
        "walk-diff" => cmd_walk_diff(&args),
        "material-diff" => cmd_material_diff(&args),
        "client-diff" => cmd_client_diff(&args),
        "scissors" => cmd_scissors(&args),
        "lowered" => cmd_lowered(&args),
        "state-dump" => cmd_state_dump(&args),
        "validate" => cmd_validate(&args),
        "live-decode" => cmd_live_decode(&args),
        "transcode" => cmd_transcode(&args),
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
        Some(Ok(v)) if (2..=wire::LATEST).contains(&v) => Some(v),
        Some(_) => return usage(),
    };
    let opts = match args.get("sabotage") {
        None => GoldenOptions::default(),
        Some("skip-payload-hash") => GoldenOptions {
            verify_payload_hashes: false,
            ..GoldenOptions::default()
        },
        // render-stream-11.md decision 10: golden-11's inline recordings must then fail.
        Some("early-prune") => GoldenOptions {
            early_prune: true,
            ..GoldenOptions::default()
        },
        // render-stream-13.md "Sabotages": golden-13's predict.rs13 and patch.rs13 must then fail.
        Some("no-predict-reset") => GoldenOptions {
            no_predict_reset: true,
            ..GoldenOptions::default()
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
    if opts.early_prune {
        println!("rs-core-check goldens (sabotage early-prune): {failed} check(s) FAILED");
    } else if opts.verify_payload_hashes {
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
                "rs-core-check diff: {}: not a render-stream/2..8 recording",
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
                early_prune: false,
                no_predict_reset: false,
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
        .ok_or_else(|| wire::Error::new("bad-magic", "not a render-stream/2..8 recording"))?;
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
            early_prune: false,
            no_predict_reset: false,
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
        match digest {
            DigestPolicy::Inline => "inline",
            DigestPolicy::Deferred => "deferred",
            DigestPolicy::Never => "none",
        },
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
        "none" => DigestPolicy::Never,
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

/// `transcode` (W13a): /12 <-> /13, or `--roundtrip` over /12 recordings.
fn cmd_transcode(args: &Args) -> ExitCode {
    use render_stream_core::predict;
    if args.get("roundtrip").is_some() {
        if args.positional.is_empty() {
            return usage();
        }
        let mut failed = false;
        println!("file\tbytes12\tbytes13\tratio\ttransactions\traw\tfirst\tsecond\troundtrip");
        for path in &args.positional {
            let run = || -> Result<(usize, usize, usize, [usize; 3], bool), wire::Error> {
                let d12 = std::fs::read(path)
                    .map_err(|e| wire::Error::new("io-error", e.to_string()))?;
                let mut trace = Vec::new();
                let d13 = predict::to13(&d12, false, Some(&mut trace))?;
                let back = predict::to12(&d13, false)?;
                Ok((d12.len(), d13.len(), trace.len(), predict::order_counts(&trace), back == d12))
            };
            match run() {
                Ok((b12, b13, txs, [o0, o1, o2], same)) => {
                    failed |= !same;
                    println!(
                        "{path}\t{b12}\t{b13}\t{:.4}\t{txs}\t{o0}\t{o1}\t{o2}\t{}",
                        b13 as f64 / b12.max(1) as f64,
                        if same { "identical" } else { "DIFFERS" }
                    );
                }
                Err(e) => {
                    failed = true;
                    println!("{path}\t{}\t{}", e.code, e.detail);
                }
            }
        }
        return if failed {
            ExitCode::FAILURE
        } else {
            ExitCode::SUCCESS
        };
    }
    let to = match args.get("to") {
        Some("12") => 12u8,
        Some("13") => 13u8,
        _ => return usage(),
    };
    let [input, output] = args.positional.as_slice() else {
        return usage();
    };
    let data = match std::fs::read(input) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("rs-core-check transcode: {input}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let got = if to == 13 {
        predict::to13(&data, args.get("stale").is_some(), None)
    } else {
        predict::to12(&data, false)
    };
    match got {
        Ok(out) => {
            if let Err(e) = std::fs::write(output, &out) {
                eprintln!("rs-core-check transcode: {output}: {e}");
                return ExitCode::FAILURE;
            }
            println!(
                "{input}\t{}\t{output}\t{}\t{:.4}",
                data.len(),
                out.len(),
                out.len() as f64 / data.len().max(1) as f64
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("{input}\t{}\t{}", e.code, e.detail);
            ExitCode::FAILURE
        }
    }
}

fn cmd_validate(args: &Args) -> ExitCode {
    let forced = match args.get("version").map(|v| v.parse::<u8>()) {
        None => None,
        Some(Ok(v)) if (2..=wire::LATEST).contains(&v) => Some(v),
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
                    payloads.accept_transaction(&v, span.bytes(&data))?;
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

/// `profile <recording> --store <dir> [--repeats N] [--digest inline|deferred] [--clock time|allocs]` (G7o2): the GSW
/// page's per-transaction pipeline natively (`render_stream_core::prof::replay`: accept, prepare +
/// needed, provide from the store, apply, then the deferred digest), one JSON line per
/// transaction with each timer's and each phase's minimum over the repeats (µs) and the
/// transaction's counts. Store files are read once, before the clock. PH2: `--clock allocs` counts
/// allocations instead of microseconds (every phase and `_us` field is then a count).
fn cmd_profile(args: &Args) -> ExitCode {
    use render_stream_core::prof;
    use render_stream_core::state::Hash;
    use std::collections::HashMap;
    let Some(path) = args.positional.first() else {
        return usage();
    };
    let store = args.get("store").map(PathBuf::from);
    let repeats = args
        .get("repeats")
        .and_then(|r| r.parse::<usize>().ok())
        .unwrap_or(5)
        .max(1);
    let inline = args.get("digest") == Some("inline");
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("rs-core-check profile: {path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    fn clock() -> f64 {
        static T0: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1e6
    }
    fn allocations() -> u64 {
        ALLOCATIONS.load(std::sync::atomic::Ordering::Relaxed)
    }
    // PH2: `--clock allocs` makes every phase (and every `_us` field) an allocation count.
    fn alloc_clock() -> f64 {
        allocations() as f64
    }
    match args.get("clock") {
        None | Some("time") => prof::set_clock(Some(clock)),
        Some("allocs") => prof::set_clock(Some(alloc_clock)),
        Some(_) => return usage(),
    }
    prof::set_alloc_counter(Some(allocations));
    let mut files: HashMap<Hash, Option<Vec<u8>>> = HashMap::new();
    let mut read = |h: &Hash| -> Option<Vec<u8>> {
        files
            .entry(*h)
            .or_insert_with(|| {
                let dir = store.as_ref()?;
                ["grt", "grm", "grp"].iter().find_map(|ext| {
                    std::fs::read(dir.join("sha256").join(format!("{}.{ext}", h.to_hex()))).ok()
                })
            })
            .clone()
    };
    let mut runs = Vec::new();
    for _ in 0..repeats {
        match prof::replay(&data, inline, &mut read) {
            Ok(rows) => runs.push(rows),
            Err(e) => {
                eprintln!("rs-core-check profile: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    let out = std::io::stdout();
    let mut w = out.lock();
    for row in prof::min_over(runs) {
        let _ = writeln!(w, "{}", row.to_json());
    }
    ExitCode::SUCCESS
}

/// `walk-diff <recording>... [--store <dir>]` (G7o2): replays each recording through two
/// appliers in lockstep, the incremental one and one that walks and re-assembles at every apply
/// (`Applier::always_walk`), and compares what their packed lists paint after every transaction
/// (`Applier::paint_digest`). Prints one line per recording (transactions, how many took the
/// walk, the rows-only and re-assembly paths, mismatching seqs); exits non-zero on any mismatch.
/// `--digests <file>` (G7o3) also writes, per transaction of the incremental applier, one line:
/// the recording, the seq, its paint digest, a digest of its whole packed list as it stands
/// (buffers, dirty ranges, texture operations) and its stats less the timings: two builds that
/// write the same file produce the same output.
fn cmd_walk_diff(args: &Args) -> ExitCode {
    use render_stream_core::apply::geom;
    use render_stream_core::apply::payloads::PayloadStore;
    use render_stream_core::apply::{Applier, Viewport};
    if args.positional.is_empty() {
        return usage();
    }
    let store = args.get("store").map(PathBuf::from);
    let mut digests: Option<std::io::BufWriter<std::fs::File>> = match args.get("digests") {
        Some(f) => match std::fs::File::create(f) {
            Ok(file) => Some(std::io::BufWriter::new(file)),
            Err(e) => {
                eprintln!("rs-core-check walk-diff: {f}: {e}");
                return ExitCode::FAILURE;
            }
        },
        None => None,
    };
    let mut failed = false;
    for path in &args.positional {
        let mut run = || -> Result<(usize, usize, usize, Vec<i64>), wire::Error> {
            let data =
                std::fs::read(path).map_err(|e| wire::Error::new("io", format!("{path}: {e}")))?;
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
            let vp = Viewport {
                width: size[0].max(1) as u32,
                height: size[1].max(1) as u32,
                clear: s.clear_color,
                global_xform: geom::IDENTITY,
                cull_mask: s.viewport.canvas_cull_mask as u32,
                format: gsw_canvas_draw_list::Format::Rgb10A2,
            };
            let mut inc = Applier::new(vp);
            let mut oracle = Applier::new(vp);
            oracle.always_walk = true;
            let mut payloads = PayloadStore::default();
            let mut need = Vec::new();
            let (mut n, mut walks, mut rows_only) = (0, 0, 0);
            let mut bad = Vec::new();
            for span in &spans[1..] {
                match v.accept(span.bytes(&data), span.offset)? {
                    Accepted::Resource { hash } => {
                        if let Some(b) = v.inline_payload(&hash) {
                            payloads.provide(b, &hash, version, true)?;
                        }
                    }
                    Accepted::End => {}
                    Accepted::Transaction => {
                        payloads.accept_transaction(&v, span.bytes(&data))?;
                        inc.prepare(v.state(), v.delta());
                        oracle.prepare(v.state(), v.delta());
                        inc.needed(v.state(), v.delta(), &payloads, &mut need);
                        let mut more = Vec::new();
                        oracle.needed(v.state(), v.delta(), &payloads, &mut more);
                        for h in more {
                            if !need.contains(&h) {
                                need.push(h);
                            }
                        }
                        for h in &need {
                            let dir = store.as_ref().ok_or_else(|| {
                                wire::Error::new("resource-unavailable", "no --store")
                            })?;
                            let b = ["grt", "grm", "grp"]
                                .iter()
                                .find_map(|ext| {
                                    std::fs::read(
                                        dir.join("sha256").join(format!("{}.{ext}", h.to_hex())),
                                    )
                                    .ok()
                                })
                                .ok_or_else(|| {
                                    wire::Error::new("resource-unavailable", h.to_hex())
                                })?;
                            payloads.provide(&b, h, version, true)?;
                        }
                        let st = inc.apply(v.state(), v.delta(), &payloads).clone();
                        oracle.apply(v.state(), v.delta(), &payloads);
                        n += 1;
                        if st.structural {
                            walks += 1;
                        } else if !st.reassembled && st.why == 0 {
                            rows_only += 1;
                        }
                        let paint = inc.paint_digest();
                        if paint != oracle.paint_digest() {
                            bad.push(v.state().seq);
                        }
                        if let Some(w) = digests.as_mut() {
                            let mut st = st.clone();
                            st.walk_us = 0.0;
                            st.assemble_us = 0.0;
                            let _ = writeln!(
                                w,
                                "{path} {} {} {} {}",
                                v.state().seq,
                                paint.to_hex(),
                                list_digest(&inc.list).to_hex(),
                                sha_hex(format!("{st:?}").as_bytes())
                            );
                        }
                        inc.list.consumed();
                        oracle.list.consumed();
                    }
                }
            }
            Ok((n, walks, rows_only, bad))
        };
        match run() {
            Ok((n, walks, rows_only, bad)) => {
                println!(
                    "{path}: {n} transactions, {walks} walked, {rows_only} rows-only, {} re-assembled; {} mismatching{}",
                    n - walks - rows_only,
                    bad.len(),
                    if bad.is_empty() {
                        String::new()
                    } else {
                        format!(" (seqs {:?})", &bad[..bad.len().min(20)])
                    }
                );
                failed |= !bad.is_empty();
            }
            Err(e) => {
                println!("{path}: error {e}");
                failed = true;
            }
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// `material-diff <recording>... [--store <dir>] [--sabotage mra-skip-changed|mra-skip-binding] [--baseline]`
/// (MRA): replays each recording through two appliers in lockstep, the incremental material
/// residency and binding refresh and their oracle, the full walk and full refresh before MRA
/// (`MaterialResidency::full_walk`, `Applier::always_refresh_bindings`), and compares after every
/// transaction: the needed (fetch) list in order, the material counters, the residency itself
/// (shader codes, material bindings and parameters, instance parameters), the paint digest and
/// the stats less their timings. Prints one line per recording (transactions, materials upserted,
/// parameter sets, the mismatching seqs); exits non-zero on any mismatch.
/// `--sabotage mra-skip-changed` drops one changed material per transaction from the incremental
/// visit set, `mra-skip-binding` leaves a binding whose material changed unrefreshed: the run
/// must then mismatch. Newly named shaders get a synthetic program (`synthetic_program`), so the
/// binding refresh runs natively. The whole packed list's digest is reported, not judged: two
/// appliers number their binding slots differently (a released slot goes back in `HashMap`
/// order), which `--baseline` (the oracle on both sides) shows; the paint digest compares the
/// draws with their bindings' values, whatever their slots.
fn cmd_material_diff(args: &Args) -> ExitCode {
    /// (seq, what differed) per mismatching transaction.
    type Mismatches = Vec<(i64, &'static str)>;
    use render_stream_core::apply::geom;
    use render_stream_core::apply::payloads::PayloadStore;
    use render_stream_core::apply::programs::ProgramEntry;
    use render_stream_core::apply::{Applier, Viewport};
    if args.positional.is_empty() {
        return usage();
    }
    let store = args.get("store").map(PathBuf::from);
    let baseline = args.get("baseline").is_some();
    let (skip_changed, skip_binding) = match args.get("sabotage") {
        None => (false, false),
        Some("mra-skip-changed") => (true, false),
        Some("mra-skip-binding") => (false, true),
        Some(other) => {
            eprintln!("rs-core-check material-diff: unknown sabotage {other}");
            return ExitCode::from(2);
        }
    };
    let mut failed = false;
    for path in &args.positional {
        let run = || -> Result<(usize, usize, usize, usize, Mismatches), wire::Error> {
            let data =
                std::fs::read(path).map_err(|e| wire::Error::new("io", format!("{path}: {e}")))?;
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
            let vp = Viewport {
                width: size[0].max(1) as u32,
                height: size[1].max(1) as u32,
                clear: s.clear_color,
                global_xform: geom::IDENTITY,
                cull_mask: s.viewport.canvas_cull_mask as u32,
                format: gsw_canvas_draw_list::Format::Rgb10A2,
            };
            let mut inc = Applier::new(vp);
            inc.material_residency_mut().skip_changed = skip_changed;
            inc.skip_binding_refresh = skip_binding;
            if baseline {
                inc.material_residency_mut().full_walk = true;
                inc.always_refresh_bindings = true;
            }
            let mut oracle = Applier::new(vp);
            oracle.material_residency_mut().full_walk = true;
            oracle.always_refresh_bindings = true;
            let mut payloads = PayloadStore::default();
            let (mut need, mut more) = (Vec::new(), Vec::new());
            let (mut n, mut param_sets, mut materials_upserted) = (0, 0, 0);
            let mut programs = 1u32;
            let mut slots_differ = 0usize;
            let mut bad: Vec<(i64, &'static str)> = Vec::new();
            for span in &spans[1..] {
                match v.accept(span.bytes(&data), span.offset)? {
                    Accepted::Resource { hash } => {
                        if let Some(b) = v.inline_payload(&hash) {
                            payloads.provide(b, &hash, version, true)?;
                        }
                    }
                    Accepted::End => {}
                    Accepted::Transaction => {
                        payloads.accept_transaction(&v, span.bytes(&data))?;
                        inc.prepare(v.state(), v.delta());
                        oracle.prepare(v.state(), v.delta());
                        // The adapter's part: every newly named shader gets a program. Natively
                        // there is no transpiler, so it is a synthetic one whose uniforms and
                        // samplers are its materials' parameters and its items' instance ones.
                        for (sid, hash, _) in inc.pending_shaders(v.state()) {
                            let info = synthetic_program(v.state(), sid, &hash, programs);
                            programs += 1;
                            inc.set_program(hash, ProgramEntry::Ready(info.clone()));
                            oracle.set_program(hash, ProgramEntry::Ready(info));
                        }
                        inc.needed(v.state(), v.delta(), &payloads, &mut need);
                        oracle.needed(v.state(), v.delta(), &payloads, &mut more);
                        let seq = v.state().seq;
                        if need != more {
                            bad.push((seq, "needed"));
                        }
                        for h in &need {
                            let dir = store.as_ref().ok_or_else(|| {
                                wire::Error::new("resource-unavailable", "no --store")
                            })?;
                            let b = ["grt", "grm", "grp"]
                                .iter()
                                .find_map(|ext| {
                                    std::fs::read(
                                        dir.join("sha256").join(format!("{}.{ext}", h.to_hex())),
                                    )
                                    .ok()
                                })
                                .ok_or_else(|| {
                                    wire::Error::new("resource-unavailable", h.to_hex())
                                })?;
                            payloads.provide(&b, h, version, true)?;
                        }
                        let mut a = inc.apply(v.state(), v.delta(), &payloads).clone();
                        let mut b = oracle.apply(v.state(), v.delta(), &payloads).clone();
                        n += 1;
                        materials_upserted += v.delta().materials_upserted.len();
                        param_sets += inc.material_counts.param_sets as usize;
                        if inc.material_counts != oracle.material_counts {
                            bad.push((seq, "material-counts"));
                        }
                        if !inc
                            .material_residency()
                            .same_residency(oracle.material_residency())
                        {
                            bad.push((seq, "residency"));
                        }
                        if inc.paint_digest() != oracle.paint_digest() {
                            bad.push((seq, "paint"));
                        }
                        if list_digest(&inc.list) != list_digest(&oracle.list) {
                            slots_differ += 1;
                        }
                        a.walk_us = 0.0;
                        a.assemble_us = 0.0;
                        b.walk_us = 0.0;
                        b.assemble_us = 0.0;
                        if format!("{a:?}") != format!("{b:?}") {
                            bad.push((seq, "stats"));
                        }
                        inc.list.consumed();
                        oracle.list.consumed();
                    }
                }
            }
            Ok((n, materials_upserted, param_sets, slots_differ, bad))
        };
        match run() {
            Ok((n, upserted, param_sets, slots_differ, bad)) => {
                let seqs: std::collections::BTreeSet<i64> = bad.iter().map(|b| b.0).collect();
                let mut kinds: Vec<&str> = bad.iter().map(|b| b.1).collect();
                kinds.sort_unstable();
                kinds.dedup();
                println!(
                    "{path}: {n} transactions, {upserted} materials upserted, {param_sets} param sets, binding slot numbering differs in {slots_differ}; {} mismatching{}",
                    seqs.len(),
                    if bad.is_empty() {
                        String::new()
                    } else {
                        format!(
                            " (kinds {kinds:?}; seqs {:?})",
                            seqs.iter().take(20).collect::<Vec<_>>()
                        )
                    }
                );
                failed |= !bad.is_empty();
            }
            Err(e) => {
                println!("{path}: error {e}");
                failed = true;
            }
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// `client-diff <recording>... [--store <dir>] [--sabotage ph2-skip-body-digest|ph2-skip-dep-texture|ph2-park-stale|ph2-skip-material-textures]`
/// (PH2): replays each recording through two whole pipelines in lockstep, each its own validator,
/// payload store and applier: the harness receiver's (`DigestPolicy::Inline`, every record
/// digested) with the oracles of PH2's applier paths (`always_scan_dependencies`, `move_walks`,
/// `Names::always_rebuild_materials`), and the client package's (`DigestPolicy::Never`, the
/// `DepIndex` pass, parked moves, the named materials' texture fast path). The stats
/// are compared less `why`, `structural` and `reassembled` (a parked move re-assembles where the
/// oracle re-walks, or does neither where a move flips an item that draws nothing), and the
/// assembly's own counters only when both sides assembled. After every transaction it compares the validator's
/// delta, `pruned` and `released` lists, the needed (fetch) list in order, the material counters,
/// the material residency, the paint digest and the stats less their timings, the upserted meshes'
/// and multimeshes' body identities (the client's cheaper digest must change exactly when the
/// harness's SHA-256 does), and that the harness side digested every record and the client side
/// none. A refusal must carry the same code on both sides. Newly named shaders get a
/// synthetic program on both sides (`synthetic_program`), so the binding refresh runs. Prints one
/// line per recording; exits non-zero on any mismatch. `--sabotage ph2-skip-body-digest` also
/// drops the client side's dynamic mesh body digests (state identity, which `Never` keeps): the
/// run must then mismatch (`body-digests`) on a recording with dynamic meshes;
/// `ph2-skip-dep-texture` makes the client side's dependency pass ignore changed textures'
/// dependents; `ph2-park-stale` leaves a parked entry unflipped when its item moves on or off
/// screen; `ph2-skip-material-textures` never re-builds the named materials' textures on the
/// fast path.
fn cmd_client_diff(args: &Args) -> ExitCode {
    use render_stream_core::apply::geom;
    use render_stream_core::apply::payloads::PayloadStore;
    use render_stream_core::apply::programs::ProgramEntry;
    use render_stream_core::apply::{Applier, Viewport};
    if args.positional.is_empty() {
        return usage();
    }
    let store = args.get("store").map(PathBuf::from);
    let sabotage = args.get("sabotage");
    let skip_material_textures = sabotage == Some("ph2-skip-material-textures");
    let (skip_bodies, skip_dep_textures, park_stale) = match sabotage {
        None | Some("ph2-skip-material-textures") => (false, false, false),
        Some("ph2-skip-body-digest") => (true, false, false),
        Some("ph2-skip-dep-texture") => (false, true, false),
        Some("ph2-park-stale") => (false, false, true),
        Some(other) => {
            eprintln!("rs-core-check client-diff: unknown sabotage {other}");
            return ExitCode::from(2);
        }
    };
    struct Side {
        v: Validator,
        payloads: PayloadStore,
        applier: Applier,
        need: Vec<render_stream_core::state::Hash>,
    }
    let mut failed = false;
    for path in &args.positional {
        type Run = (
            usize,
            usize,
            Option<&'static str>,
            (usize, usize),
            Vec<(i64, &'static str)>,
        );
        let run = || -> Result<Run, wire::Error> {
            let data =
                std::fs::read(path).map_err(|e| wire::Error::new("io", format!("{path}: {e}")))?;
            let version = wire::version_of_magic(&data)
                .ok_or_else(|| wire::Error::new("bad-magic", "not a render-stream recording"))?;
            let spans = wire::split_records(&data, version)?;
            let side = |digest: DigestPolicy| -> Result<Side, wire::Error> {
                let mut opts = Options::new(version);
                opts.digest = digest;
                let v = Validator::new(spans[0].bytes(&data), spans[0].offset, opts)?;
                let s = v.session();
                let size = s
                    .viewport
                    .presentation_size
                    .unwrap_or(s.viewport.logical_size);
                let vp = Viewport {
                    width: size[0].max(1) as u32,
                    height: size[1].max(1) as u32,
                    clear: s.clear_color,
                    global_xform: geom::IDENTITY,
                    cull_mask: s.viewport.canvas_cull_mask as u32,
                    format: gsw_canvas_draw_list::Format::Rgb10A2,
                };
                Ok(Side {
                    v,
                    payloads: PayloadStore::default(),
                    applier: Applier::new(vp),
                    need: Vec::new(),
                })
            };
            let mut h = side(DigestPolicy::Inline)?;
            let mut c = side(DigestPolicy::Never)?;
            c.v.set_skip_body_digests(skip_bodies);
            // The harness side runs the oracles of PH2's applier paths.
            h.applier.always_scan_dependencies = true;
            h.applier.move_walks = true;
            h.applier.names_mut().always_rebuild_materials = true;
            c.applier.skip_dep_textures = skip_dep_textures;
            c.applier.park_stale = park_stale;
            c.applier.names_mut().skip_material_rebuild = skip_material_textures;
            let (mut parked_moves, mut fallback_walks) = (0usize, 0usize);
            use std::collections::HashMap;
            let (mut last_body_h, mut last_body_c) = (HashMap::new(), HashMap::new());
            let (mut last_mm_h, mut last_mm_c) = (HashMap::new(), HashMap::new());
            let mut programs = 1u32;
            let (mut n, mut bodies) = (0usize, 0usize);
            let mut bad: Vec<(i64, &'static str)> = Vec::new();
            let mut refused: Option<&'static str> = None;
            let fetch = |hash: &render_stream_core::state::Hash| -> Result<Vec<u8>, wire::Error> {
                let dir = store
                    .as_ref()
                    .ok_or_else(|| wire::Error::new("resource-unavailable", "no --store"))?;
                ["grt", "grm", "grp"]
                    .iter()
                    .find_map(|ext| {
                        std::fs::read(dir.join("sha256").join(format!("{}.{ext}", hash.to_hex())))
                            .ok()
                    })
                    .ok_or_else(|| wire::Error::new("resource-unavailable", hash.to_hex()))
            };
            for span in &spans[1..] {
                let rec = span.bytes(&data);
                // A refusal must be the same on both sides (the client keeps every check that
                // reads no record digest); then the recording ends there.
                let (ah, ac) = match (h.v.accept(rec, span.offset), c.v.accept(rec, span.offset)) {
                    (Ok(a), Ok(b)) => (a, b),
                    (Err(a), Err(b)) if a.code == b.code => {
                        refused = Some(a.code);
                        break;
                    }
                    _ => {
                        bad.push((h.v.state().seq, "refusal"));
                        break;
                    }
                };
                let seq = h.v.state().seq;
                if ah != ac {
                    bad.push((seq, "accepted"));
                    continue;
                }
                match ah {
                    Accepted::Resource { hash } => {
                        for s in [&mut h, &mut c] {
                            if let Some(b) = s.v.inline_payload(&hash) {
                                s.payloads.provide(b, &hash, version, true)?;
                            }
                        }
                    }
                    Accepted::End => {}
                    Accepted::Transaction => {
                        n += 1;
                        bodies += h.v.dynamic_bodies().len();
                        if h.v.delta() != c.v.delta() {
                            bad.push((seq, "delta"));
                        }
                        if h.v.pruned() != c.v.pruned() || h.v.released() != c.v.released() {
                            bad.push((seq, "pruned-released"));
                        }
                        // The body digests are state identity (no-op detection, `mesh-version`,
                        // `multimesh-version`): `Never` keeps them as a cheaper identity, so each
                        // upserted entry's digests must change exactly when the harness's do (and
                        // be present exactly where they are), its other surface fields equal.
                        let (hs, cs) = (h.v.state(), c.v.state());
                        for &id in &h.v.delta().meshes_upserted {
                            let (Some(a), Some(b)) = (hs.meshes.get(&id), cs.meshes.get(&id)) else {
                                bad.push((seq, "body-digests"));
                                continue;
                            };
                            let da: Vec<_> = a.surfaces.iter().map(|x| x.body_sha256).collect();
                            let db: Vec<_> = b.surfaces.iter().map(|x| x.body_sha256).collect();
                            let mask = |m: &render_stream_core::state::Mesh| {
                                let mut m = m.clone();
                                m.surfaces.iter_mut().for_each(|x| x.body_sha256 = None);
                                m
                            };
                            let changed_a = last_body_h.get(&id) != Some(&da);
                            let changed_b = last_body_c.get(&id) != Some(&db);
                            if mask(a) != mask(b)
                                || changed_a != changed_b
                                || da.iter().zip(&db).any(|(x, y)| x.is_some() != y.is_some())
                            {
                                bad.push((seq, "body-digests"));
                            }
                            last_body_h.insert(id, da);
                            last_body_c.insert(id, db);
                        }
                        for &id in &h.v.delta().multimeshes_upserted {
                            let da = hs.multimeshes.get(&id).map(|m| m.buffer_sha256);
                            let db = cs.multimeshes.get(&id).map(|m| m.buffer_sha256);
                            let changed_a = last_mm_h.get(&id) != Some(&da);
                            let changed_b = last_mm_c.get(&id) != Some(&db);
                            if changed_a != changed_b
                                || da.map(|d| d.is_some()) != db.map(|d| d.is_some())
                            {
                                bad.push((seq, "body-digests"));
                            }
                            last_mm_h.insert(id, da);
                            last_mm_c.insert(id, db);
                        }
                        for s in [&mut h, &mut c] {
                            s.payloads.accept_transaction(&s.v, rec)?;
                            s.applier.prepare(s.v.state(), s.v.delta());
                        }
                        for (sid, hash, _) in h.applier.pending_shaders(h.v.state()) {
                            let info = synthetic_program(h.v.state(), sid, &hash, programs);
                            programs += 1;
                            h.applier.set_program(hash, ProgramEntry::Ready(info.clone()));
                            c.applier.set_program(hash, ProgramEntry::Ready(info));
                        }
                        for s in [&mut h, &mut c] {
                            s.applier
                                .needed(s.v.state(), s.v.delta(), &s.payloads, &mut s.need);
                        }
                        if h.need != c.need {
                            bad.push((seq, "needed"));
                        }
                        for s in [&mut h, &mut c] {
                            for hash in s.need.clone() {
                                let b = fetch(&hash)?;
                                s.payloads.provide(&b, &hash, version, true)?;
                            }
                        }
                        let mut a = h.applier.apply(h.v.state(), h.v.delta(), &h.payloads).clone();
                        let mut b = c.applier.apply(c.v.state(), c.v.delta(), &c.payloads).clone();
                        if h.applier.material_counts != c.applier.material_counts {
                            bad.push((seq, "material-counts"));
                        }
                        if !h
                            .applier
                            .material_residency()
                            .same_residency(c.applier.material_residency())
                        {
                            bad.push((seq, "residency"));
                        }
                        if h.applier.paint_digest() != c.applier.paint_digest() {
                            bad.push((seq, "paint"));
                        }
                        // How the two got there may differ (a parked move re-assembles where the
                        // oracle re-walks); what they drew may not.
                        use render_stream_core::apply::Why;
                        parked_moves += usize::from(b.why & Why::MOVE_ATTACH != 0);
                        fallback_walks += usize::from(a.why & Why::MOVE_FALLBACK != 0);
                        // The assembly's own counters exist only where it ran.
                        let both = (a.structural || a.reassembled) && (b.structural || b.reassembled);
                        for st in [&mut a, &mut b] {
                            st.walk_us = 0.0;
                            st.assemble_us = 0.0;
                            st.why = 0;
                            st.structural = false;
                            st.reassembled = false;
                            if !both {
                                st.attached_items = 0;
                                st.lowered_draws = 0;
                                st.assembly_skips = 0;
                            }
                        }
                        if format!("{a:?}") != format!("{b:?}") {
                            if !bad.iter().any(|x| x.1 == "stats") {
                                eprintln!("seq {seq} stats differ:\n  harness {a:?}\n  client  {b:?}");
                            }
                            bad.push((seq, "stats"));
                        }
                        h.applier.list.consumed();
                        c.applier.list.consumed();
                    }
                }
            }
            let digests = |v: &Validator| v.record_digests().iter().filter(|d| d.is_some()).count();
            let records = h.v.record_digests().len();
            if digests(&h.v) != records || (refused.is_none() && records != spans.len()) {
                bad.push((-1, "harness-digests"));
            }
            if digests(&c.v) != 0 {
                bad.push((-1, "client-digests"));
            }
            Ok((n, bodies, refused, (parked_moves, fallback_walks), bad))
        };
        match run() {
            Ok((n, bodies, refused, (parked, walks), bad)) => {
                let seqs: std::collections::BTreeSet<i64> = bad.iter().map(|b| b.0).collect();
                let mut kinds: Vec<&str> = bad.iter().map(|b| b.1).collect();
                kinds.sort_unstable();
                kinds.dedup();
                println!(
                    "{path}: {n} transactions, {bodies} dynamic bodies, {parked} parked moves (oracle: {walks} move walks){}; {} mismatching{}",
                    refused.map_or(String::new(), |c| format!(", both refused {c}")),
                    seqs.len(),
                    if bad.is_empty() {
                        String::new()
                    } else {
                        format!(
                            " (kinds {kinds:?}; seqs {:?})",
                            seqs.iter().take(20).collect::<Vec<_>>()
                        )
                    }
                );
                failed |= !bad.is_empty();
            }
            Err(e) => {
                println!("{path}: error {e}");
                failed = true;
            }
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// MRA (`material-diff`): a stand-in for the transpiler's program of shader `sid`: a uniform per
/// scalar or 2-4 component parameter of the `ok` materials on it (instance uniforms from the
/// instance parameters of the items drawing them), a sampler per texture parameter, and its own
/// vertex stage for odd hashes (so its binding reads its canvas transform).
fn synthetic_program(
    state: &render_stream_core::state::ResolvedState,
    sid: render_stream_core::state::Id,
    hash: &render_stream_core::state::Hash,
    program: u32,
) -> render_stream_core::apply::programs::ProgramInfo {
    use render_stream_core::state::{EntryStatus, Param, ParamValue, VariantType};
    let mut seen = std::collections::BTreeSet::new();
    let (mut uniforms, mut samplers) = (Vec::new(), Vec::new());
    let mut add = |p: &Param, instance: bool| {
        if !seen.insert(p.name.to_string()) {
            return;
        }
        let (ty, n) = match (&p.value, p.ty) {
            (ParamValue::Tex(_), _) => {
                samplers.push(json!({"name": &*p.name, "filter": "linear", "repeat": false}));
                return;
            }
            (ParamValue::Scalar(_), VariantType::Bool) => ("bool", 1),
            (ParamValue::Scalar(_), VariantType::Int) => ("int", 1),
            (ParamValue::Scalar(_), _) => ("float", 1),
            (ParamValue::Flat(v), _) if (2..=4).contains(&v.len()) => {
                (["vec2", "vec3", "vec4"][v.len() - 2], v.len())
            }
            _ => return,
        };
        uniforms.push(
            json!({"name": &*p.name, "type": ty, "components": n, "instance": instance,
            "integer": false, "unset": vec![0.0; n]}),
        );
    };
    let mats: Vec<_> = state
        .materials
        .values()
        .filter(|m| m.status == EntryStatus::Ok && m.shader == Some(sid))
        .collect();
    for m in &mats {
        for p in &m.params {
            add(p, false);
        }
    }
    for it in state.items.values() {
        if it.material.is_some_and(|m| mats.iter().any(|x| x.id == m)) {
            for p in &it.instance_params {
                add(p, true);
            }
        }
    }
    let meta = json!({"blend": "mix", "lightMode": "normal", "uniforms": uniforms,
        "samplers": samplers, "screenTexture": null, "vertexStage": hash.0[0] & 1 == 1,
        "time": false});
    render_stream_core::apply::programs::ProgramInfo::from_meta_json(program, &meta.to_string())
        .expect("a synthetic program's metadata parses")
}

/// A digest of a packed list's whole contents as they stand (its `Debug` form, streamed).
fn list_digest(l: &gsw_canvas_draw_list::DrawList) -> render_stream_core::state::Hash {
    use sha2::{Digest, Sha256};
    struct W(Sha256);
    impl std::fmt::Write for W {
        fn write_str(&mut self, s: &str) -> std::fmt::Result {
            self.0.update(s.as_bytes());
            Ok(())
        }
    }
    let mut w = W(Sha256::new());
    let _ = std::fmt::Write::write_fmt(&mut w, format_args!("{l:?}"));
    let mut out = [0u8; 32];
    out.copy_from_slice(&w.0.finalize());
    render_stream_core::state::Hash(out)
}

fn sha_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
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

/// `lowered <recording> --seqs a,b,... [--store <dir>]` (gate7-design.md G7t, Q14d "Lowering"):
/// replays every transaction through the applier (natively, no GL) and, after each listed seq,
/// prints one JSON line `{"seq":n,"items":[{"id":i,"pos":[x,y,...],"col":[r,g,b,a,...],
/// "idx":[...]},...]}`: every item's lowered vertices (item-local, its draw transforms applied, f32
/// values), straight vertex colours and indices. `scripts/lib/gate7-gsw-g45.ts`'s
/// `lowering-parity` finds every hand-lowered shape of gate 5's expected.json in them bit for bit.
fn cmd_lowered(args: &Args) -> ExitCode {
    use render_stream_core::apply::geom;
    use render_stream_core::apply::payloads::PayloadStore;
    use render_stream_core::apply::{Applier, Viewport};
    let (Some(path), Some(seqs)) = (args.positional.first(), args.get("seqs")) else {
        return usage();
    };
    let seqs: Vec<i64> = seqs
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
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
                    a.apply(v.state(), v.delta(), &payloads);
                    a.list.consumed();
                    if !seqs.contains(&v.state().seq) {
                        continue;
                    }
                    let items: Vec<J> = a
                        .lowered_items()
                        .into_iter()
                        .map(|(id, l)| {
                            let pos: Vec<f32> = l.verts.iter().flat_map(|x| x.pos).collect();
                            let col: Vec<f32> = l.verts.iter().flat_map(|x| x.color).collect();
                            json!({"id": id, "pos": pos, "col": col, "idx": l.idx})
                        })
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
            eprintln!("rs-core-check lowered: {e}");
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

/// W11t: decodes a coded-message file (`rs_live_coding_tool encode`, or a live client's capture of
/// what it received) through rs-core's `LiveDecoder`, the receivers' decoder, and compares the
/// result with `--expect` (a recording: its magic + session, then each record, as messages).
/// Prints one JSON object: messages, prefixed, equal, the first mismatch, and the decode time per
/// transaction (min over --repeats passes; --stats writes one JSON line per transaction). A
/// sabotage drops the first based message's base (`drop-base`) or flips its prefix's first byte
/// (`wrong-prefix`); the object then reports the `coding` error and how many based messages
/// were skipped after it.
fn cmd_live_decode(args: &Args) -> ExitCode {
    let Some(path) = args.positional.first() else {
        return usage();
    };
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{path}: {e}");
            return ExitCode::from(1);
        }
    };
    let messages = match coding::split_messages(&data) {
        Ok(m) => m,
        Err(e) => {
            println!("{}", json!({"error": e.to_string()}));
            return ExitCode::from(1);
        }
    };
    let keep = args.get("bases").unwrap_or("keep") == "keep";
    let repeats: usize = args
        .get("repeats")
        .and_then(|r| r.parse().ok())
        .unwrap_or(1)
        .max(1);
    let sabotage = args.get("sabotage");
    let expected: Option<Vec<Vec<u8>>> = match args.get("expect") {
        None => None,
        Some(p) => {
            let rec = match std::fs::read(p) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("{p}: {e}");
                    return ExitCode::from(1);
                }
            };
            let Some(version) = wire::version_of_magic(&rec) else {
                eprintln!("{p}: no render-stream magic");
                return ExitCode::from(1);
            };
            let spans = match wire::split_records(&rec, version) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{p}: {e}");
                    return ExitCode::from(1);
                }
            };
            let mut out = Vec::new();
            for (i, span) in spans.iter().enumerate() {
                if i == 0 {
                    out.push(rec[..span.offset + span.byte_length].to_vec());
                } else {
                    out.push(span.bytes(&rec).to_vec());
                }
            }
            Some(out)
        }
    };
    let mut best = vec![f64::INFINITY; messages.len()];
    let mut summary = json!({});
    for pass in 0..repeats {
        let mut d = LiveDecoder::new(keep, 1 << 30);
        let mut equal = 0usize;
        let mut first_mismatch: Option<usize> = None;
        let mut error: Option<J> = None;
        let mut skipped = 0usize;
        let mut sabotaged = false;
        let mut prefixed = 0usize;
        let mut max_retained = 0usize;
        let mut max_retained_bytes = 0usize;
        for (i, m) in messages.iter().enumerate() {
            let based = m.len() >= coding::ENVELOPE_LEN
                && u32::from_le_bytes([m[0], m[1], m[2], m[3]]) == coding::ENVELOPE_MAGIC
                && m[16..24] != [0u8; 8];
            if based {
                prefixed += 1;
            }
            if !sabotaged && based && i + 1 < messages.len() {
                match sabotage {
                    Some("drop-base") => {
                        // Message i never arrives: the next transaction is coded against it.
                        sabotaged = true;
                        continue;
                    }
                    Some("wrong-prefix") => {
                        sabotaged = true;
                        d.sabotage_wrong_prefix = true;
                    }
                    _ => {}
                }
            }
            let t0 = Instant::now();
            let r = d.decode(m);
            let us = t0.elapsed().as_secs_f64() * 1e6;
            best[i] = best[i].min(us);
            max_retained = max_retained.max(d.retained().len());
            max_retained_bytes = max_retained_bytes.max(d.retained_bytes());
            match r {
                Ok(Outcome::Skipped) => skipped += 1,
                Ok(Outcome::Plain) => {
                    if expected
                        .as_ref()
                        .map(|e| e.get(i).map(|x| &x[..]) == Some(&m[..]))
                        == Some(true)
                    {
                        equal += 1;
                    } else if first_mismatch.is_none() {
                        first_mismatch = Some(i);
                    }
                }
                Ok(Outcome::Decoded) => {
                    let ok = match &expected {
                        Some(e) => e.get(i).map(|x| &x[..]) == Some(d.output()),
                        None => true,
                    };
                    if ok {
                        equal += 1;
                    } else if first_mismatch.is_none() {
                        first_mismatch = Some(i);
                    }
                }
                Err(e) => {
                    if error.is_none() {
                        error = Some(
                            json!({"index": i, "seq": d.seq(), "code": e.code, "detail": e.detail}),
                        );
                    }
                }
            }
        }
        if pass + 1 == repeats {
            summary = json!({
                "messages": messages.len(),
                "prefixed": prefixed,
                "expected": expected.as_ref().map(|e| e.len()),
                "equal": equal,
                "first_mismatch": first_mismatch,
                "error": error,
                "skipped": skipped,
                "coded_bytes": d.stats.coded_bytes,
                "decoded_bytes": d.stats.decoded_bytes,
                "max_retained": max_retained,
                "max_retained_bytes": max_retained_bytes,
                "sabotage": sabotage,
            });
        }
    }
    if let Some(p) = args.get("stats") {
        let mut f = match std::fs::File::create(p) {
            Ok(f) => std::io::BufWriter::new(f),
            Err(e) => {
                eprintln!("{p}: {e}");
                return ExitCode::from(1);
            }
        };
        for (i, m) in messages.iter().enumerate() {
            if m.len() >= coding::ENVELOPE_LEN
                && u32::from_le_bytes([m[0], m[1], m[2], m[3]]) == coding::ENVELOPE_MAGIC
            {
                let seq = u64::from_le_bytes(m[8..16].try_into().unwrap());
                let base = u64::from_le_bytes(m[16..24].try_into().unwrap());
                let _ = writeln!(
                    f,
                    "{}",
                    json!({"index": i, "seq": seq, "base_seq": base, "coded_bytes": m.len(), "decode_us": (best[i] * 10.0).round() / 10.0})
                );
            }
        }
    }
    let total: f64 = best.iter().filter(|x| x.is_finite()).sum();
    summary["decode_us_total"] = json!((total * 10.0).round() / 10.0);
    println!("{summary}");
    let ok = summary["error"].is_null()
        && summary["first_mismatch"].is_null()
        && (expected.is_none() || summary["equal"] == summary["expected"]);
    if ok || sabotage.is_some() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
