//! Native run of the decode cost prototype: `rs-decode-proto <recording> [repeats]`, one JSON line out.
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(path) = args.get(1) else {
        eprintln!("usage: rs-decode-proto <recording.rs2> [repeats]");
        std::process::exit(2);
    };
    let repeats: usize = args.get(2).and_then(|r| r.parse().ok()).unwrap_or(5);
    let data = std::fs::read(path).expect("read recording");
    let start = Instant::now();
    let now = || start.elapsed().as_secs_f64() * 1e6;
    match rs_decode_proto::run(&data, repeats, &now) {
        Ok(r) => {
            let stages: Vec<String> = rs_decode_proto::STAGES
                .iter()
                .zip(r.stage_mean_us)
                .map(|(name, us)| format!("\"{name}\":{us:.2}"))
                .collect();
            println!(
                "{{\"arm\":\"native\",\"soft_sha\":{},\"transactions\":{},\"total_mean_us\":{:.2},\"total_p50_us\":{:.2},\"total_p95_us\":{:.2},\"stages\":{{{}}}}}",
                cfg!(feature = "soft-sha"),
                r.transactions,
                r.total_mean_us,
                r.total_p50_us,
                r.total_p95_us,
                stages.join(",")
            );
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
