//! render-stream/15 tools (render-stream-15.md "Tools"): `rs-core-check transcode --to 14` of a
//! /15 recording. Both hint record types are dropped and every texture entry's `size_override`
//! key is removed; the end record's `bytes_total` and `max_record_bytes` follow (as `to12`'s do).
//! Texture versions that rose only for an override stay risen, which /14 permits. Everything else
//! is byte for byte the input's: a /15 transaction without an override is the /14 one, and the
//! key sits in the meta only, so no predicted block moves.

use crate::validate::{Accepted, Options, Validator};
use crate::wire::{self, Error};

const PROTOCOL_14: &[u8] = b"\"protocol\":\"render-stream/14\"";
const PROTOCOL_15: &[u8] = b"\"protocol\":\"render-stream/15\"";
const SIZE_OVERRIDE: &[u8] = b",\"size_override\":[";

/// A canonical transaction meta without its `size_override` keys (`None` when it has none). The
/// key only ever follows a texture's `variants` array, so it is always preceded by a comma; its
/// value is `[<int>,<int>]`, so the first `]` closes it. A string value cannot hold the literal
/// (its quotes would be escaped).
fn strip_size_overrides(meta: &[u8]) -> Option<Vec<u8>> {
    let mut at = meta
        .windows(SIZE_OVERRIDE.len())
        .position(|w| w == SIZE_OVERRIDE)?;
    let mut out = Vec::with_capacity(meta.len());
    let mut from = 0;
    loop {
        out.extend_from_slice(&meta[from..at]);
        let close = meta[at..].iter().position(|&b| b == b']')? + at;
        from = close + 1;
        match meta[from..]
            .windows(SIZE_OVERRIDE.len())
            .position(|w| w == SIZE_OVERRIDE)
        {
            Some(i) => at = from + i,
            None => break,
        }
    }
    out.extend_from_slice(&meta[from..]);
    Some(out)
}

/// `rs-core-check transcode --to 14` from /15: validates the input (its first error is returned)
/// and writes the /14 stream of it.
pub fn to14_from15(data15: &[u8]) -> Result<Vec<u8>, Error> {
    let spans = wire::split_records(data15, 15)?;
    let first = spans
        .first()
        .ok_or_else(|| Error::new("missing-session", "the recording has no records"))?;
    let mut v = Validator::new(first.bytes(data15), first.offset, Options::new(15))?;
    let mut out = wire::magic(14).to_vec();
    out.reserve(data15.len());
    crate::predict::swap_protocol(first.bytes(data15), PROTOCOL_15, PROTOCOL_14, &mut out)?;
    let mut out_lens = vec![out.len() - wire::MAGIC_LEN];
    let mut in_lens = vec![first.bytes(data15).len()];
    for span in &spans[1..] {
        let rec = span.bytes(data15);
        let at = out.len();
        match v.accept(rec, span.offset)? {
            Accepted::ResourceHint { .. } | Accepted::ResourceUnhint { .. } => {}
            Accepted::End => crate::predict::fix_end(rec, &out_lens, &in_lens, &mut out),
            Accepted::Transaction => {
                let meta_len = wire::le_u32(rec, 4) as usize;
                match strip_size_overrides(&rec[8..8 + meta_len]) {
                    Some(meta) => {
                        crate::predict::make_record(&mut out, &[&meta], &rec[8 + meta_len..])
                    }
                    None => out.extend_from_slice(rec),
                }
            }
            Accepted::Resource { .. } | Accepted::ItemMeta => out.extend_from_slice(rec),
        }
        out_lens.push(out.len() - at);
        in_lens.push(rec.len());
    }
    v.finish()?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::validate_recording;
    use std::path::PathBuf;

    fn golden(rel: &str) -> Vec<u8> {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../protocol");
        std::fs::read(base.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
    }

    #[test]
    fn strip_removes_every_override_and_nothing_else() {
        let meta = br#"{"textures":[{"variants":[],"size_override":[3366,2047],"canvas":null},{"variants":[{"a":1}],"canvas":null},{"variants":[],"size_override":[1,2],"canvas":null}]}"#;
        let got = strip_size_overrides(meta).unwrap();
        assert_eq!(
            got,
            br#"{"textures":[{"variants":[],"canvas":null},{"variants":[{"a":1}],"canvas":null},{"variants":[],"canvas":null}]}"#
        );
        assert_eq!(strip_size_overrides(br#"{"textures":[]}"#), None);
    }

    /// `data` with `rec` inserted as record `at` (the end record's bytes_total following).
    fn insert(data: &[u8], at: usize, rec: &[u8]) -> Vec<u8> {
        let spans = wire::split_records(data, 15).unwrap();
        let mut out = wire::magic(15).to_vec();
        for (i, span) in spans.iter().enumerate() {
            if i == at {
                out.extend_from_slice(rec);
            }
            if i + 1 == spans.len() {
                crate::predict::fix_end(span.bytes(data), &[rec.len()], &[], &mut out);
            } else {
                out.extend_from_slice(span.bytes(data));
            }
        }
        out
    }

    fn record(meta: &str) -> Vec<u8> {
        let mut out = Vec::new();
        crate::predict::make_record(&mut out, &[meta.as_bytes()], &0u32.to_le_bytes());
        out
    }

    /// The record index of transaction `seq`.
    fn tx_index(data: &[u8], seq: i64) -> usize {
        let spans = wire::split_records(data, 15).unwrap();
        let needle = format!("{{\"type\":\"transaction\",\"seq\":{seq},");
        spans
            .iter()
            .position(|s| {
                let r = s.bytes(data);
                r[8..].starts_with(needle.as_bytes())
            })
            .unwrap()
    }

    /// `hint-meta` reaches entries a transaction does not carry: a hint made after seq 13 that
    /// disagrees with texture 5 (which seq 13 set and patch seq 14 leaves alone) fails seq 14.
    #[test]
    fn a_fresh_hint_is_checked_against_the_whole_state() {
        let hints = golden("golden-15/hints.rs15");
        let c = "010fa78f5252bba55d7f689e94974819078dbe444ca78233993e50f709184047";
        let hint = |w: u32| {
            record(&format!(
                "{{\"type\":\"resource_hint\",\"hash\":\"{c}\",\"kind\":\"texture\",\"format\":\"LA8\",\"source_format\":null,\"width\":{w},\"height\":4,\"mipmaps\":false,\"payload_bytes\":137,\"variants\":[],\"path\":null,\"cause\":\"create\",\"priority\":9,\"blocks\":[]}}"
            ))
        };
        let at = tx_index(&hints, 14);
        let good = insert(&hints, at, &hint(4));
        validate_recording(&good, Options::new(15)).expect("an agreeing hint is valid");
        let bad = insert(&hints, at, &hint(5));
        let got = crate::goldens::first_failure(&bad, Options::new(15)).expect("fails");
        assert_eq!((got.0.code, got.2), ("hint-meta", Some(14)), "{}", got.0);
        // Unhinted again before seq 14, it is not checked.
        let unhint = record(&format!(
            "{{\"type\":\"resource_unhint\",\"hash\":\"{c}\",\"blocks\":[]}}"
        ));
        let gone = insert(&bad, at + 1, &unhint);
        validate_recording(&gone, Options::new(15)).expect("unhinted before the transaction");
    }

    /// golden-15's hints lane transcodes to its `hints.rs14` twin byte for byte, which validates at
    /// /14; `--to 13` (through /14) validates at /13; a re-stamped golden-14 lane goes back to
    /// itself.
    #[test]
    fn golden15_transcodes_to_14_and_13() {
        let hints = golden("golden-15/hints.rs15");
        let want = golden("golden-15/hints.rs14");
        let got = to14_from15(&hints).expect("hints.rs15 transcodes");
        assert!(
            got == want,
            "transcode --to 14 of hints.rs15 differs from hints.rs14"
        );
        validate_recording(&got, Options::new(14)).expect("hints.rs14 validates at /14");
        let d13 = crate::item_meta::to13_from14(&got).expect("through /14 to /13");
        validate_recording(&d13, Options::new(13)).expect("validates at /13");
        for lane in ["full", "patch", "inline", "predict"] {
            let d15 = golden(&format!("golden-15/{lane}.rs15"));
            let d14 = golden(&format!("golden-14/{lane}.rs14"));
            assert!(to14_from15(&d15).unwrap() == d14, "{lane}.rs15 -> /14");
        }
    }
}
