//! Where a transaction's accept time goes: JSON parse alone vs the whole accept (native).
//! `cargo run --release --example parse_cost -- <recording>`
use render_stream_core::json::{Buffers, Doc};
use render_stream_core::validate::{DigestPolicy, Options, Validator};
use render_stream_core::wire;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("recording");
    let data = std::fs::read(path).unwrap();
    let version = wire::version_of_magic(&data).unwrap();
    let spans = wire::split_records(&data, version).unwrap();
    let mut parse = Vec::new();
    let mut accept = Vec::new();
    for _ in 0..10 {
        let mut b = Buffers::default();
        for s in &spans[1..] {
            let f = wire::frame(s.bytes(&data), s.offset).unwrap();
            let t = Instant::now();
            let doc = Doc::parse_with(f.meta, b).ok().unwrap();
            parse.push(t.elapsed().as_secs_f64() * 1e6);
            b = doc.into_buffers();
        }
        let mut opts = Options::new(version);
        opts.digest = DigestPolicy::Deferred;
        let mut v = Validator::new(spans[0].bytes(&data), spans[0].offset, opts).unwrap();
        for s in &spans[1..] {
            let t = Instant::now();
            v.accept(s.bytes(&data), s.offset).unwrap();
            accept.push(t.elapsed().as_secs_f64() * 1e6);
        }
    }
    let med = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    println!(
        "parse p50 {:.1} us, accept p50 {:.1} us",
        med(&mut parse),
        med(&mut accept)
    );
}
