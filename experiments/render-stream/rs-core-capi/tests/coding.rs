//! W11t: the C ABI's live-coding decoder (`rsc_coding_*`) over golden-11's coded patch stream
//! (protocol/golden-11/coding/patch.coded, the capture encoder's output): every message decodes
//! to the recording's, a dropped base is -1 with the seq to resync, and an uncoded connection
//! passes its messages through.

use render_stream_core::{coding, wire};
use rs_core_capi::*;
use std::path::PathBuf;

fn golden11() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol/golden-11")
}

fn expected() -> Vec<Vec<u8>> {
    let rec = std::fs::read(golden11().join("patch.rs11")).unwrap();
    let spans = wire::split_records(&rec, 11).unwrap();
    spans
        .iter()
        .enumerate()
        .map(|(i, s)| {
            if i == 0 {
                rec[..s.offset + s.byte_length].to_vec()
            } else {
                s.bytes(&rec).to_vec()
            }
        })
        .collect()
}

unsafe fn decode(h: *mut RscCoding, m: &[u8]) -> (i32, Vec<u8>) {
    let mut out: *const u8 = std::ptr::null();
    let mut n = 0usize;
    let r = rsc_coding_decode(h, m.as_ptr(), m.len(), &mut out, &mut n);
    let bytes = if n == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(out, n).to_vec()
    };
    (r, bytes)
}

#[test]
fn capi_decodes_the_golden_coded_stream() {
    let coded = std::fs::read(golden11().join("coding/patch.coded")).unwrap();
    let messages = coding::split_messages(&coded).unwrap();
    let want = expected();
    unsafe {
        let offer = b"zstd-base,zstd";
        let h = rsc_coding_new(offer.as_ptr(), offer.len(), 1 << 24);
        for (i, m) in messages.iter().enumerate() {
            let (r, bytes) = decode(h, m);
            assert_eq!(r, 1, "message {i}");
            assert_eq!(bytes, want[i], "message {i}");
        }
        let mut n = 0usize;
        let p = rsc_coding_stats(h, &mut n);
        let stats = std::str::from_utf8(std::slice::from_raw_parts(p, n)).unwrap();
        assert!(
            stats.contains("\"coded\":true") && stats.contains("\"prefixed\":17"),
            "{stats}"
        );
        rsc_coding_free(h);

        // drop-base: skip the first based message; the next names a base not retained.
        let first = messages
            .iter()
            .position(|m| {
                u32::from_le_bytes([m[0], m[1], m[2], m[3]]) == coding::ENVELOPE_MAGIC
                    && m[16..24] != [0u8; 8]
            })
            .unwrap();
        let h = rsc_coding_new(offer.as_ptr(), offer.len(), 1 << 24);
        let mut failed = false;
        for (i, m) in messages.iter().enumerate() {
            if i == first {
                continue;
            }
            let (r, _) = decode(h, m);
            if r == -1 {
                let mut n = 0usize;
                let p = rsc_coding_error(h, &mut n);
                let e = std::str::from_utf8(std::slice::from_raw_parts(p, n)).unwrap();
                assert!(
                    e.starts_with("coding: ") && e.contains("not retained"),
                    "{e}"
                );
                assert!(rsc_coding_seq(h) > 0);
                failed = true;
                break;
            }
        }
        assert!(failed);
        rsc_coding_free(h);

        // An uncoded connection: every message is its own bytes (2).
        let h = rsc_coding_new(std::ptr::null(), 0, 1 << 24);
        for m in &want {
            let (r, bytes) = decode(h, m);
            assert_eq!((r, &bytes), (2, m));
        }
        rsc_coding_free(h);
    }
}
