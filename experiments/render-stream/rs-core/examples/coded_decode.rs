//! BIN-D (results/p3/bin-d.md): rs-core's W11t decoder (`coding::LiveDecoder`, ruzstd) on the
//! messages of one /13 variant, per message, natively.
//! `cargo run --release --example coded_decode -- <frames> <plain.msgs> [passes]`
//! (`bin13-bench frames` writes <frames> from `wire-budget.py bin13 --dump`'s <plain.msgs>).
//! Each pass is a fresh decoder over the whole sequence; each message's time is its minimum over
//! the passes, and every output is compared with the plain message.
use render_stream_core::coding::LiveDecoder;
use std::time::Instant;

fn load(path: &str) -> Vec<Vec<u8>> {
    let d = std::fs::read(path).unwrap();
    let n = u32::from_le_bytes(d[0..4].try_into().unwrap()) as usize;
    let mut p = 4;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let l = u32::from_le_bytes(d[p..p + 4].try_into().unwrap()) as usize;
        out.push(d[p + 4..p + 4 + l].to_vec());
        p += 4 + l;
    }
    out
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let frames = load(&a[1]);
    let plain = load(&a[2]);
    let passes: usize = a.get(3).map(|s| s.parse().unwrap()).unwrap_or(7);
    let mut best = vec![f64::MAX; frames.len()];
    for _ in 0..passes {
        let mut d = LiveDecoder::new(true, 1 << 28);
        for (i, f) in frames.iter().enumerate() {
            let t = Instant::now();
            d.decode(f).unwrap();
            let us = t.elapsed().as_secs_f64() * 1e6;
            assert_eq!(d.output(), &plain[i][..], "message {i}");
            best[i] = best[i].min(us);
        }
    }
    let mut v: Vec<f64> = best[1..].to_vec(); // message 0 has no base
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    v.sort_by(|x, y| x.partial_cmp(y).unwrap());
    println!(
        "{}: {} messages, {passes} passes: decode_us p50 {:.1} p95 {:.1} mean {:.1}",
        a[1],
        v.len(),
        v[v.len() / 2],
        v[v.len() * 95 / 100],
        mean
    );
}
