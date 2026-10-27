//! W11t (render-stream-11.md "As built (W11t)"): rs-core's live-coding decoder for the browser
//! receivers. A `LiveCoding` sits beside a connection's `GswRs` and decodes each WebSocket message
//! in place in its receive buffer (`decode_rx`), before `live_session` / `live_accept` parse it, so
//! the coded path adds no copy across the wasm boundary. `decode` is the same over a byte slice,
//! for clients without a `GswRs` (Node's live legs); `coding_bench` times rs-core's decode in wasm.

use crate::{performance_now, GswRs};
use render_stream_core::coding::{self, LiveDecoder, Outcome};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct LiveCoding {
    d: LiveDecoder,
    error: String,
}

#[wasm_bindgen]
impl LiveCoding {
    /// `offer` is the hello's `live_coding` value this receiver sent (`zstd-base,zstd` keeps
    /// bases; `zstd` keeps none); `max_bytes` its `inbound_buffer_bytes`.
    #[wasm_bindgen(constructor)]
    pub fn new(offer: &str, max_bytes: f64) -> LiveCoding {
        let keep = offer.split(',').any(|t| t == "zstd-base");
        LiveCoding {
            d: LiveDecoder::new(keep, max_bytes as u64),
            error: String::new(),
        }
    }

    /// Decodes the `len`-byte message in `g`'s receive buffer in place. Returns the uncoded
    /// length (> 0, the buffer now holds it), 0 for a based transaction skipped while a resync
    /// is pending (drop it: no apply, no ack), or -1 (`error()`, code `coding`; resync `seq()`
    /// when it is not 0, else fail the stream).
    pub fn decode_rx(&mut self, g: &mut GswRs, len: usize) -> i32 {
        match self.d.decode(&g.rx[..len]) {
            Ok(Outcome::Plain) => len as i32,
            Ok(Outcome::Skipped) => 0,
            Ok(Outcome::Decoded) => {
                let out = self.d.output();
                if g.rx.len() < out.len() {
                    g.rx.resize(out.len(), 0);
                }
                g.rx[..out.len()].copy_from_slice(out);
                out.len() as i32
            }
            Err(e) => {
                self.error = e.to_string();
                -1
            }
        }
    }

    /// `decode_rx` over a slice: the uncoded bytes, or undefined (skipped, or an error: then
    /// `error()` is non-empty).
    pub fn decode(&mut self, msg: &[u8]) -> Option<Vec<u8>> {
        self.error.clear();
        match self.d.decode(msg) {
            Ok(Outcome::Plain) => Some(msg.to_vec()),
            Ok(Outcome::Skipped) => None,
            Ok(Outcome::Decoded) => Some(self.d.output().to_vec()),
            Err(e) => {
                self.error = e.to_string();
                None
            }
        }
    }

    pub fn error(&self) -> String {
        self.error.clone()
    }

    /// The last message's envelope seq (0: not a transaction).
    pub fn seq(&self) -> f64 {
        self.d.seq() as f64
    }

    pub fn base_seq(&self) -> f64 {
        self.d.base_seq() as f64
    }

    /// 1 coded, 0 uncoded, -1 before the first message.
    pub fn coded(&self) -> i32 {
        match self.d.coded() {
            None => -1,
            Some(true) => 1,
            Some(false) => 0,
        }
    }

    /// `{"coded":..,"messages":..,"prefixed":..,"skipped":..,"errors":..,"coded_bytes":..,
    /// "decoded_bytes":..,"retained":[seqs],"retained_bytes":..}` for the receiver's evidence.
    pub fn stats_json(&self) -> String {
        let s = self.d.stats;
        format!(
            "{{\"coded\":{},\"messages\":{},\"prefixed\":{},\"skipped\":{},\"errors\":{},\"coded_bytes\":{},\"decoded_bytes\":{},\"retained\":{:?},\"retained_bytes\":{}}}",
            match self.d.coded() {
                None => "null",
                Some(true) => "true",
                Some(false) => "false",
            },
            s.messages,
            s.prefixed,
            s.skipped,
            s.errors,
            s.coded_bytes,
            s.decoded_bytes,
            self.d.retained(),
            self.d.retained_bytes()
        )
    }
}

/// Diagnostics: decode every message of a coded-message file (`rs_live_coding_tool encode`)
/// `repeats` times with a fresh decoder per pass; the minimum µs per message.
#[wasm_bindgen]
pub fn coding_bench(coded: &[u8], repeats: u32) -> Result<Vec<f64>, JsValue> {
    let messages = coding::split_messages(coded).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let mut best = vec![f64::INFINITY; messages.len()];
    for _ in 0..repeats.max(1) {
        let mut d = LiveDecoder::new(true, 1 << 30);
        for (i, m) in messages.iter().enumerate() {
            let t = performance_now();
            d.decode(m).map_err(|e| JsValue::from_str(&e.to_string()))?;
            best[i] = best[i].min((performance_now() - t) * 1000.0);
        }
    }
    Ok(best)
}
