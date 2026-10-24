//! Texture delivery, receiver side (texture-delivery-design.md D3, Q3; G8kp): which payload of an
//! `ok` image texture a receiver fetches and uploads.
//!
//! **D3's fixed rule.** The receiver's own hello lists `texture_encodings` (its preference, from
//! `block`, `uastc`, `etc1s`, `decoded`) and `gpu_formats` (Godot's feature names it can upload:
//! `s3tc`, `bptc`, `rgtc`, `etc2`, `astc`, or `none`). The chosen payload is the first encoding of
//! `texture_encodings` that the entry lists, where `block` counts only if the variant's format
//! family is in `gpu_formats`, and `decoded` (the base entry, always present, D5) comes last
//! whatever the list says. A receiver with no transcoder never lists `uastc`/`etc1s`; one that
//! does gets no Basis choice here until G8ku, so the rule falls through to `decoded`.
//!
//! [`DeliveryPrefs::default`] is `decoded` alone: every receiver that is not configured, and every
//! stream below /9 (whose entries carry no variants), picks exactly the hash it always did.

use crate::state::{EntryStatus, Hash, Texture, TextureKind, VariantEncoding};

/// Godot's feature name for a block format (`RenderingServer.has_os_feature`, texture-delivery-
/// design.md Q3): the family a `block` variant needs in `gpu_formats`. None for every format
/// render-stream-9.md never offers as a variant.
pub fn block_family(format: &str) -> Option<&'static str> {
    Some(match format {
        "DXT1" | "DXT3" | "DXT5" => "s3tc",
        "BPTC_RGBA" => "bptc",
        "RGTC_R" | "RGTC_RG" => "rgtc",
        "ETC" | "ETC2_R11" | "ETC2_R11S" | "ETC2_RG11" | "ETC2_RG11S" | "ETC2_RGB8"
        | "ETC2_RGBA8" | "ETC2_RGB8A1" => "etc2",
        "ASTC_4x4" | "ASTC_8x8" => "astc",
        _ => return None,
    })
}

/// The families [`block_family`] knows, in the order hellos list them.
pub const FAMILIES: [&str; 5] = ["s3tc", "bptc", "rgtc", "etc2", "astc"];
/// The encodings a hello may list (render-stream-9.md "Live transport").
pub const ENCODINGS: [&str; 4] = ["block", "uastc", "etc1s", "decoded"];

/// `^[a-z0-9]+(,[a-z0-9]+)*$`, at most 96 characters (render-stream-9.md "Live transport").
pub fn valid_list(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 96
        && text.split(',').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// A receiver's delivery preferences, as its hello states them.
#[derive(Clone, Debug, PartialEq)]
pub struct DeliveryPrefs {
    /// `texture_encodings`, in order (`decoded` is implied last when absent).
    pub encodings: Vec<Box<str>>,
    /// `gpu_formats` (empty for `none`).
    pub gpu_formats: Vec<Box<str>>,
}

impl Default for DeliveryPrefs {
    fn default() -> Self {
        DeliveryPrefs {
            encodings: vec!["decoded".into()],
            gpu_formats: Vec::new(),
        }
    }
}

/// What D3 chose for one entry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Selected<'a> {
    pub hash: Hash,
    /// `"decoded"` or `"block"`.
    pub encoding: &'static str,
    /// The block variant's format (None for `decoded`: the payload names its own).
    pub format: Option<&'a str>,
}

impl DeliveryPrefs {
    /// From the two hello strings. Each must be a valid list of known names (`gpu_formats` may be
    /// `none`); a name this build does not know is an error, so a typo never silently means
    /// `decoded`.
    pub fn parse(encodings: &str, gpu_formats: &str) -> Result<DeliveryPrefs, String> {
        if !valid_list(encodings) {
            return Err(format!(
                "texture_encodings {encodings:?} is not a comma-separated list of [a-z0-9]+ (<= 96 chars)"
            ));
        }
        if !valid_list(gpu_formats) {
            return Err(format!(
                "gpu_formats {gpu_formats:?} is not a comma-separated list of [a-z0-9]+ (<= 96 chars)"
            ));
        }
        let mut enc: Vec<Box<str>> = Vec::new();
        for e in encodings.split(',') {
            if !ENCODINGS.contains(&e) {
                return Err(format!(
                    "texture_encodings names {e:?} (expected block, uastc, etc1s, decoded)"
                ));
            }
            if enc.iter().any(|x| &**x == e) {
                return Err(format!("texture_encodings names {e:?} twice"));
            }
            enc.push(e.into());
        }
        let mut gpu: Vec<Box<str>> = Vec::new();
        if gpu_formats != "none" {
            for f in gpu_formats.split(',') {
                if !FAMILIES.contains(&f) {
                    return Err(format!(
                        "gpu_formats names {f:?} (expected s3tc, bptc, rgtc, etc2, astc or none)"
                    ));
                }
                if gpu.iter().any(|x| &**x == f) {
                    return Err(format!("gpu_formats names {f:?} twice"));
                }
                gpu.push(f.into());
            }
        }
        Ok(DeliveryPrefs {
            encodings: enc,
            gpu_formats: gpu,
        })
    }

    /// `gpu_formats` as the hello spells it (`none` when empty).
    pub fn gpu_formats_text(&self) -> String {
        if self.gpu_formats.is_empty() {
            "none".to_string()
        } else {
            self.gpu_formats.join(",")
        }
    }

    pub fn encodings_text(&self) -> String {
        self.encodings.join(",")
    }

    /// Whether the receiver can upload `family` (a [`block_family`] name).
    pub fn has_family(&self, family: &str) -> bool {
        self.gpu_formats.iter().any(|f| &**f == family)
    }

    /// D3 for one texture entry: None unless it is an `ok` image with a hash.
    pub fn select<'a>(&self, t: &'a Texture) -> Option<Selected<'a>> {
        if t.kind != TextureKind::Image || t.status != EntryStatus::Ok {
            return None;
        }
        let base = t.hash?;
        let decoded = Selected {
            hash: base,
            encoding: "decoded",
            format: None,
        };
        for e in &self.encodings {
            match &**e {
                "decoded" => return Some(decoded),
                "block" => {
                    let hit = t.variants.iter().find(|v| {
                        v.encoding == VariantEncoding::Block
                            && v.format
                                .as_deref()
                                .and_then(block_family)
                                .is_some_and(|fam| self.has_family(fam))
                    });
                    if let Some(v) = hit {
                        return Some(Selected {
                            hash: v.hash,
                            encoding: "block",
                            format: v.format.as_deref(),
                        });
                    }
                }
                // uastc / etc1s: no transcoder in this build (G8ku, G8kb).
                _ => {}
            }
        }
        Some(decoded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::TextureVariant;

    fn tex(variants: Vec<TextureVariant>) -> Texture {
        Texture {
            id: 1,
            origin: crate::state::Origin::Created,
            adopted_content: None,
            kind: TextureKind::Image,
            status: EntryStatus::Ok,
            reason: None,
            version: 1,
            hash: Some(Hash([1; 32])),
            format: Some("RGBA8".into()),
            source_format: None,
            width: 4,
            height: 4,
            mipmaps: false,
            payload_bytes: 10,
            variants,
            canvas: None,
        }
    }

    fn block(format: &str, b: u8) -> TextureVariant {
        TextureVariant {
            encoding: VariantEncoding::Block,
            hash: Hash([b; 32]),
            payload_bytes: 10,
            format: Some(format.into()),
            params: None,
        }
    }

    #[test]
    fn default_is_decoded() {
        let t = tex(vec![block("DXT1", 2)]);
        let s = DeliveryPrefs::default().select(&t).unwrap();
        assert_eq!((s.encoding, s.hash), ("decoded", Hash([1; 32])));
    }

    #[test]
    fn block_needs_its_family() {
        let p = DeliveryPrefs::parse("block,decoded", "s3tc,rgtc").unwrap();
        assert_eq!(p.select(&tex(vec![block("DXT5", 2)])).unwrap().encoding, "block");
        assert_eq!(p.select(&tex(vec![block("BPTC_RGBA", 2)])).unwrap().encoding, "decoded");
        assert_eq!(p.select(&tex(vec![block("ETC2_RGB8", 2)])).unwrap().encoding, "decoded");
        assert_eq!(p.select(&tex(vec![])).unwrap().encoding, "decoded");
        let masked = DeliveryPrefs::parse("block,decoded", "none").unwrap();
        assert_eq!(masked.select(&tex(vec![block("DXT5", 2)])).unwrap().encoding, "decoded");
    }

    #[test]
    fn decoded_first_wins() {
        let p = DeliveryPrefs::parse("decoded,block", "s3tc").unwrap();
        assert_eq!(p.select(&tex(vec![block("DXT1", 2)])).unwrap().encoding, "decoded");
    }

    #[test]
    fn parse_refuses_unknown_names() {
        assert!(DeliveryPrefs::parse("block,png", "s3tc").is_err());
        assert!(DeliveryPrefs::parse("block", "s3tc,pvrtc").is_err());
        assert!(DeliveryPrefs::parse("", "none").is_err());
        assert!(DeliveryPrefs::parse("Block", "none").is_err());
        assert_eq!(
            DeliveryPrefs::parse("block,decoded", "none").unwrap().gpu_formats_text(),
            "none"
        );
    }
}
