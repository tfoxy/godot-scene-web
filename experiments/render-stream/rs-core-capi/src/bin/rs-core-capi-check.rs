//! `rs-core-capi-check`: replays native receiver legs through the Rust adapter without Godot and
//! compares its apply against the GDScript receiver's own evidence.
//!
//!   rs-core-capi-check legs <leg dir>...
//!
//! A leg dir holds what a gate runner's receiver leg wrote: `env.txt` (RS_RECEIVER_* words),
//! `applied.json` and the recording (file mode: RS_RECEIVER_RECORDING; live mode: every
//! `streams[].received_path`). For every transaction the GDScript receiver applied, the adapter
//! applies the same resolved state (live: after accepting every record up to that transaction,
//! as `_apply_newest` does), and its statistics must equal the leg's: created, freed,
//! reparented, commands_replayed, msdf_commands, mesh_commands, rs_calls, every apply-side
//! `resources` counter, and the `uploads`/`mesh_uploads` entries. `record_sha256` is compared
//! for every transaction entry. The same replay then runs with `full_scan` (the former GDScript applier, `rs_applier.gd`, removed in G7gd; its
//! O(state) walk) and the two RenderingServer call streams must be identical.
//!
//! Payloads come from the inline resource records, the leg's RS_RECEIVER_STORE_DIR and its
//! RS_RECEIVER_SHADER_LIBRARY, as the receiver's RsResourceCache would give them. A live leg with
//! no store falls back to the host's or capture's store, then to its RS_RECEIVER_CACHE_DIR.
//! Exit status 0 when every leg matches, 1 otherwise; legs whose GDScript run failed before
//! applying anything are reported as skipped.

use render_stream_core::payload;
use render_stream_core::state::Hash;
use render_stream_core::wire;
use rs_core_capi::core::{Core, KIND_ERROR, KIND_RESOURCE, KIND_TRANSACTION};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Reads a Variant tree back into JSON (ints stay ints), so stats compare with applied.json.
fn vt_to_json(b: &[u8], at: &mut usize) -> Value {
    let tag = b[*at];
    *at += 1;
    let u32_at = |b: &[u8], at: &mut usize| {
        let v = u32::from_le_bytes(b[*at..*at + 4].try_into().unwrap());
        *at += 4;
        v as usize
    };
    let str_at = |b: &[u8], at: &mut usize| {
        let n = u32::from_le_bytes(b[*at..*at + 4].try_into().unwrap()) as usize;
        *at += 4;
        let s = String::from_utf8(b[*at..*at + n].to_vec()).unwrap();
        *at += n;
        s
    };
    match tag {
        0 => Value::Null,
        1 => {
            let v = b[*at] != 0;
            *at += 1;
            Value::Bool(v)
        }
        2 => {
            let v = i64::from_le_bytes(b[*at..*at + 8].try_into().unwrap());
            *at += 8;
            Value::from(v)
        }
        3 => {
            let v = f64::from_le_bytes(b[*at..*at + 8].try_into().unwrap());
            *at += 8;
            Value::from(v)
        }
        4 => Value::String(str_at(b, at)),
        5 => {
            let n = u32_at(b, at);
            Value::Array((0..n).map(|_| vt_to_json(b, at)).collect())
        }
        6 => {
            let n = u32_at(b, at);
            let mut m = serde_json::Map::new();
            for _ in 0..n {
                let k = str_at(b, at);
                let v = vt_to_json(b, at);
                m.insert(k, v);
            }
            Value::Object(m)
        }
        7 => {
            *at += 1;
            let n = b[*at] as usize;
            *at += 1 + 8 * n;
            Value::String("<math>".into())
        }
        8 => {
            let _ty = b[*at];
            *at += 1;
            let n = u32_at(b, at);
            // components are not recorded; the check only reads packed float32 (one component).
            let mut out = Vec::new();
            for _ in 0..n {
                let v = f64::from_le_bytes(b[*at..*at + 8].try_into().unwrap());
                *at += 8;
                out.push(Value::from(v));
            }
            Value::Array(out)
        }
        9 => {
            *at += 4;
            Value::String("<rid>".into())
        }
        10 => {
            let n = u32_at(b, at);
            Value::Array((0..n).map(|_| Value::String(str_at(b, at))).collect())
        }
        t => panic!("vt tag {t}"),
    }
}

fn vt(core: &Core) -> Value {
    let mut at = 0;
    vt_to_json(&core.vt.out, &mut at)
}

fn read_env(dir: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(text) = std::fs::read_to_string(dir.join("env.txt")) {
        for line in text.lines() {
            if line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                out.insert(k.to_string(), v.to_string());
            }
        }
    }
    out
}

struct Sources {
    inline: HashMap<Hash, Vec<u8>>,
    store: Option<PathBuf>,
    library: Option<PathBuf>,
}

impl Sources {
    fn payload(&self, h: &Hash, mesh: bool, shader: bool) -> Option<Vec<u8>> {
        if let Some(p) = self.inline.get(h) {
            return Some(p.clone());
        }
        let ext = if shader {
            "grp"
        } else if mesh {
            "grm"
        } else {
            "grt"
        };
        let store = self.store.as_ref()?;
        std::fs::read(store.join("sha256").join(format!("{}.{ext}", h.to_hex()))).ok()
    }
    fn library(&self, hash: &str) -> (bool, String) {
        let Some(lib) = &self.library else {
            return (false, "RS_RECEIVER_SHADER_LIBRARY is unset".into());
        };
        let path = lib.join("sha256").join(format!("{hash}.grp"));
        let Ok(bytes) = std::fs::read(&path) else {
            return (false, format!("the library has no {}", path.display()));
        };
        if wire::sha256(&bytes).to_hex() != hash {
            return (
                false,
                format!("{} does not hash to its name", path.display()),
            );
        }
        match payload::decode_shader(&bytes) {
            Ok(p) => (true, p.code.to_string()),
            Err(e) => (false, format!("{}: {}", path.display(), e)),
        }
    }
}

const RESOURCE_KEYS: [&str; 19] = [
    "created",
    "updated",
    "replaced",
    "freed",
    "upload_bytes",
    "skipped_commands",
    "meshes_created",
    "meshes_rebuilt",
    "surface_updates",
    "mesh_upload_bytes",
    "skipped_mesh_commands",
    "shaders_created",
    "shader_code_sets",
    "materials_created",
    "param_sets",
    "instance_param_sets",
    "canvases_created",
    "canvas_attach",
    "canvas_stacking_sets",
];

/// The adapter's stats in applied.json's per-transaction shape.
fn entry_of(stats: &Value) -> Value {
    let mut res = serde_json::Map::new();
    let r = &stats["resources"];
    for k in [
        "created",
        "updated",
        "replaced",
        "freed",
        "upload_bytes",
        "skipped_commands",
    ] {
        res.insert(k.into(), r[k].clone());
    }
    let m = &stats["mesh_resources"];
    for k in [
        "meshes_created",
        "meshes_rebuilt",
        "surface_updates",
        "mesh_upload_bytes",
        "skipped_mesh_commands",
    ] {
        res.insert(k.into(), m[k].clone());
    }
    let mr = &stats["material_resources"];
    for k in [
        "shaders_created",
        "shader_code_sets",
        "materials_created",
        "param_sets",
        "instance_param_sets",
    ] {
        res.insert(k.into(), mr[k].clone());
    }
    let cr = &stats["canvas_resources"];
    for k in ["canvases_created", "canvas_attach", "canvas_stacking_sets"] {
        res.insert(k.into(), cr[k].clone());
    }
    serde_json::json!({
        "created": stats["created"], "freed": stats["freed"], "reparented": stats["reparented"],
        "commands_replayed": stats["commands_replayed"], "msdf_commands": stats["msdf_commands"],
        "mesh_commands": stats["mesh_commands"], "rs_calls": stats["rs_calls"],
        "resources": Value::Object(res),
    })
}

/// The adapter's apply of one transaction: its entry fields, uploads and mesh_uploads.
type Applied = (Value, Vec<Value>, Vec<Value>);

struct Replay {
    /// (stream, seq) -> what the adapter applied
    applied: HashMap<(i64, i64), Applied>,
    digests: HashMap<(i64, i64), String>,
    ops: Vec<(Vec<u32>, Vec<u8>)>,
    error: Option<String>,
}

fn replay(
    streams: &[(i64, Vec<u8>)],
    applied_seqs: &HashMap<i64, Vec<i64>>,
    sources: &mut Sources,
    sabotage: &str,
    full_scan: bool,
) -> Replay {
    let mut out = Replay {
        applied: HashMap::new(),
        digests: HashMap::new(),
        ops: Vec::new(),
        error: None,
    };
    let mut core = Core::new();
    core.set_sabotage(sabotage);
    core.planner.full_scan = full_scan;
    for (si, (stream, data)) in streams.iter().enumerate() {
        if si > 0 {
            core.dispose();
            out.ops
                .push((core.ops.words.clone(), core.ops.arena.clone()));
        }
        // G7xwl: a /7 live receiver's received.rs7 replays at /7; everything else at /6.
        let version = match wire::version_of_magic(data) {
            Some(7) => 7,
            _ => 6,
        };
        let spans = match wire::split_records(data, version) {
            Ok(s) => s,
            Err(e) => {
                out.error = Some(format!("split: {e}"));
                return out;
            }
        };
        let empty = Vec::new();
        let want = applied_seqs.get(stream).unwrap_or(&empty);
        for (ri, span) in spans.iter().enumerate() {
            if ri == 0 {
                if core.session(data, span.offset, version) == KIND_ERROR {
                    out.error = Some(format!("session: {}", vt(&core)["errors"]));
                    return out;
                }
                core.begin_session();
                out.ops
                    .push((core.ops.words.clone(), core.ops.arena.clone()));
                continue;
            }
            let kind = core.accept(data, span.offset);
            if kind == KIND_ERROR {
                out.error = Some(format!("accept: {}", vt(&core)["errors"]));
                return out;
            }
            let rec = vt(&core);
            if kind == KIND_RESOURCE {
                if core.resource_payload() {
                    let h =
                        Hash::from_hex(rec["record"]["meta"]["hash"].as_str().unwrap()).unwrap();
                    sources.inline.insert(h, core.text.clone());
                }
                continue;
            }
            if kind != KIND_TRANSACTION {
                continue;
            }
            let seq = rec["record"]["meta"]["seq"].as_i64().unwrap();
            out.digests.insert(
                (*stream, seq),
                rec["record"]["sha256"].as_str().unwrap().to_string(),
            );
            if !want.contains(&seq) {
                continue;
            }
            core.needed();
            let need = vt(&core);
            let meshes: Vec<&str> = need["mesh_hashes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            let shaders: Vec<&str> = need["shader_hashes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            for h in need["hashes"].as_array().unwrap() {
                let h = h.as_str().unwrap();
                let hh = Hash::from_hex(h).unwrap();
                let Some(bytes) = sources.payload(&hh, meshes.contains(&h), shaders.contains(&h))
                else {
                    out.error = Some(format!("seq {seq}: payload {h} unavailable"));
                    return out;
                };
                if let Err(e) = core.provide(h, &bytes) {
                    out.error = Some(format!("seq {seq}: provide {h}: {e}"));
                    return out;
                }
            }
            for h in need["library"].as_array().unwrap() {
                let h = h.as_str().unwrap();
                let (ok, body) = sources.library(h);
                core.provide_library(h, ok, &body);
            }
            if let Err(e) = core.apply() {
                out.error = Some(format!("seq {seq}: apply: {e}"));
                return out;
            }
            out.ops
                .push((core.ops.words.clone(), core.ops.arena.clone()));
            let stats = vt(&core);
            let uploads = stats["uploads"].as_array().unwrap().clone();
            let mesh_uploads = stats["mesh_uploads"].as_array().unwrap().clone();
            out.applied
                .insert((*stream, seq), (entry_of(&stats), uploads, mesh_uploads));
        }
    }
    out
}

fn check_leg(dir: &Path) -> Result<String, String> {
    let env = read_env(dir);
    let applied: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("applied.json"))
            .map_err(|e| format!("applied.json: {e}"))?,
    )
    .map_err(|e| format!("applied.json: {e}"))?;
    let live = env
        .get("RS_RECEIVER_MODE")
        .map(|m| m == "live")
        .unwrap_or(false);
    let mut streams: Vec<(i64, Vec<u8>)> = Vec::new();
    if live {
        for (k, s) in applied["streams"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .enumerate()
        {
            let path = s["received_path"].as_str().unwrap_or("");
            let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
            streams.push(((k + 1) as i64, bytes));
        }
    } else {
        let path = env
            .get("RS_RECEIVER_RECORDING")
            .ok_or("env.txt has no RS_RECEIVER_RECORDING")?;
        streams.push((1, std::fs::read(path).map_err(|e| format!("{path}: {e}"))?));
    }
    let txs = applied["transactions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut applied_seqs: HashMap<i64, Vec<i64>> = HashMap::new();
    for t in &txs {
        if t["rs_calls"].is_null() {
            continue;
        }
        applied_seqs
            .entry(t["stream"].as_i64().unwrap())
            .or_default()
            .push(t["seq"].as_i64().unwrap());
    }
    if applied_seqs.is_empty() {
        return Ok(format!(
            "skipped (no applied transaction; status {})",
            applied["status"]
        ));
    }
    let sabotage = env.get("RS_RECEIVER_SABOTAGE").cloned().unwrap_or_default();
    let mut sources = Sources {
        inline: HashMap::new(),
        store: env.get("RS_RECEIVER_STORE_DIR").map(PathBuf::from),
        library: env.get("RS_RECEIVER_SHADER_LIBRARY").map(PathBuf::from),
    };
    // Live legs fetch over HTTP from the host's store: the capture's store sits beside the host.
    // A host that keeps its store in memory (gate 6's rates legs) leaves only the receiver's own
    // cache, which holds every payload the GDScript receiver fetched and verified.
    if sources.store.is_none() {
        let cache = env.get("RS_RECEIVER_CACHE_DIR").map(PathBuf::from);
        for cand in [dir.join("../host/store"), dir.join("../capture/store")]
            .into_iter()
            .chain(cache)
        {
            if cand.is_dir() {
                sources.store = Some(cand);
                break;
            }
        }
    }
    let delta = replay(&streams, &applied_seqs, &mut sources, &sabotage, false);
    let full = replay(&streams, &applied_seqs, &mut sources, &sabotage, true);
    let mut problems: Vec<String> = Vec::new();
    if let Some(e) = &delta.error {
        // A GDScript leg that failed mid-stream stops there too; anything else is a mismatch.
        if applied["status"] == "ok" {
            problems.push(format!("delta replay: {e}"));
        }
    }
    if delta.ops != full.ops {
        let first = delta
            .ops
            .iter()
            .zip(&full.ops)
            .position(|(a, b)| a != b)
            .unwrap_or(delta.ops.len().min(full.ops.len()));
        problems.push(format!(
            "delta and full-scan call streams differ (call batch {first} of {}/{})",
            delta.ops.len(),
            full.ops.len()
        ));
    }
    let uploads = applied["uploads"].as_array().cloned().unwrap_or_default();
    let mesh_uploads = applied["mesh_uploads"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let strip = |v: &Value| {
        let mut v = v.clone();
        if let Some(o) = v.as_object_mut() {
            o.remove("stream");
            o.remove("seq");
        }
        v
    };
    let mut compared = 0;
    for t in &txs {
        let key = (t["stream"].as_i64().unwrap(), t["seq"].as_i64().unwrap());
        if let Some(d) = delta.digests.get(&key) {
            if t["record_sha256"].as_str() != Some(d.as_str()) {
                problems.push(format!("{key:?} record_sha256 differs"));
            }
        }
        if t["rs_calls"].is_null() {
            continue;
        }
        let Some((mine, my_uploads, my_mesh_uploads)) = delta.applied.get(&key) else {
            if delta.error.is_none() {
                problems.push(format!("{key:?} was not applied by the adapter"));
            }
            continue;
        };
        compared += 1;
        let mut theirs = serde_json::Map::new();
        for k in [
            "created",
            "freed",
            "reparented",
            "commands_replayed",
            "msdf_commands",
            "mesh_commands",
            "rs_calls",
        ] {
            theirs.insert(k.into(), t[k].clone());
        }
        let mut res = serde_json::Map::new();
        for k in RESOURCE_KEYS {
            res.insert(k.into(), t["resources"][k].clone());
        }
        theirs.insert("resources".into(), Value::Object(res));
        let theirs = Value::Object(theirs);
        if *mine != theirs {
            problems.push(format!(
                "{key:?} stats differ:\n  gdscript {theirs}\n  rust     {mine}"
            ));
        }
        let pick = |list: &[Value]| -> Vec<Value> {
            list.iter()
                .filter(|u| u["stream"].as_i64() == Some(key.0) && u["seq"].as_i64() == Some(key.1))
                .map(strip)
                .collect()
        };
        let (tu, tm) = (pick(&uploads), pick(&mesh_uploads));
        if applied["uploads"].is_array() && tu != *my_uploads {
            problems.push(format!(
                "{key:?} uploads differ:\n  gdscript {tu:?}\n  rust     {my_uploads:?}"
            ));
        }
        if applied["mesh_uploads"].is_array() && tm != *my_mesh_uploads {
            problems.push(format!(
                "{key:?} mesh_uploads differ:\n  gdscript {tm:?}\n  rust     {my_mesh_uploads:?}"
            ));
        }
    }
    if problems.is_empty() {
        Ok(format!(
            "ok ({compared} applied transactions, {} call batches, sabotage {:?})",
            delta.ops.len(),
            sabotage
        ))
    } else {
        problems.truncate(8);
        Err(problems.join("\n"))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(|s| s.as_str()) != Some("legs") || args.len() < 2 {
        eprintln!("usage: rs-core-capi-check legs <leg dir>...");
        std::process::exit(2);
    }
    let mut failed = 0;
    let mut passed = 0;
    let mut skipped = 0;
    for d in &args[1..] {
        let dir = Path::new(d);
        match check_leg(dir) {
            Ok(msg) => {
                if msg.starts_with("skipped") {
                    skipped += 1;
                } else {
                    passed += 1;
                }
                println!("{d}: {msg}");
            }
            Err(msg) => {
                failed += 1;
                println!("{d}: MISMATCH\n{msg}");
            }
        }
    }
    println!("rs-core-capi-check: {passed} legs match, {failed} differ, {skipped} skipped");
    std::process::exit(if failed > 0 { 1 } else { 0 });
}
