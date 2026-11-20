//! Which texels of a straight RGBA8 texture are fully opaque (alpha 255), kept compactly so a
//! caller can ask whether a texel rectangle is opaque throughout (an atlas region, say).
//!
//! Built once per texture from its level-0 bytes ([`Opacity::from_rgba8`]), or on the first
//! question that needs it ([`Opacity::lazy`]: most textures are never asked about a rectangle,
//! and whether a texture has an opaque texel, or only opaque ones, is answered by a scan that
//! stops at the first texel that decides it). The texture is cut into [`BLOCK`]×[`BLOCK`] blocks: a block whose every texel is opaque or
//! whose every texel is not costs one table word, and only a block holding both keeps one bit per
//! texel. A query is exact: it reads the table and, for mixed blocks, the bit rows.

/// Block edge in texels: one `u32` bit row per block row.
pub const BLOCK: u32 = 32;

const ALL: u32 = u32::MAX;
const NONE: u32 = u32::MAX - 1;

/// The opaque texels of one texture.
pub struct Opacity {
    width: u32,
    height: u32,
    /// The table, once built.
    kind: std::sync::OnceLock<Kind>,
    /// The pixels the table is built from, until it is ([`Opacity::lazy`]).
    src: std::sync::Mutex<Option<crate::SharedBytes>>,
    /// [`Opacity::any`] and [`Opacity::all`] answered before the table is built.
    any: std::sync::OnceLock<bool>,
    all: std::sync::OnceLock<bool>,
    /// [`Opacity::id`].
    id: u64,
    nonzero: Option<crate::alpha::AlphaTable>,
}

/// The texels it describes (the identity and whether the table is built yet are not).
impl std::fmt::Debug for Opacity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Opacity")
            .field("width", &self.width)
            .field("height", &self.height)
            .finish_non_exhaustive()
    }
}

impl Clone for Opacity {
    fn clone(&self) -> Opacity {
        Opacity {
            width: self.width,
            height: self.height,
            kind: self.kind.clone(),
            src: std::sync::Mutex::new(self.src_bytes()),
            any: self.any.clone(),
            all: self.all.clone(),
            id: self.id,
            nonzero: self.nonzero.clone(),
        }
    }
}

/// Equal texels, whatever the identity.
impl PartialEq for Opacity {
    fn eq(&self, o: &Opacity) -> bool {
        self.width == o.width && self.height == o.height && self.kind() == o.kind()
    }
}

impl Eq for Opacity {}

/// The next [`Opacity::id`] (0 is never one).
fn next_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Kind {
    /// Every texel is opaque.
    All,
    /// No texel is opaque.
    None,
    /// Per block (row-major, `ceil(width / BLOCK)` per row): [`ALL`], [`NONE`], or the index of
    /// its first bit row in `rows` (`BLOCK` rows, bit `x` of a row = texel `x` of the block is
    /// opaque; texels past the texture's edge read as not opaque).
    Blocks { blocks: Vec<u32>, rows: Vec<u32> },
}

impl Opacity {
    /// The opacity of a `width × height` straight RGBA8 level 0 (`rgba` holds at least
    /// `4·width·height` bytes; a short buffer yields an all-transparent answer).
    pub fn from_rgba8(width: u32, height: u32, rgba: &[u8]) -> Opacity {
        Opacity {
            width,
            height,
            kind: Kind::build(width, height, rgba).into(),
            src: std::sync::Mutex::new(None),
            any: std::sync::OnceLock::new(),
            all: std::sync::OnceLock::new(),
            id: next_id(),
            nonzero: crate::alpha::AlphaTable::from_rgba8(width, height, rgba),
        }
    }

    /// [`Opacity::from_rgba8`] of `rgba`, built when first needed: until then it holds the
    /// pixels (shared, not copied).
    pub fn lazy(width: u32, height: u32, rgba: crate::SharedBytes) -> Opacity {
        Opacity {
            width,
            height,
            kind: std::sync::OnceLock::new(),
            src: std::sync::Mutex::new(Some(rgba.clone())),
            any: std::sync::OnceLock::new(),
            all: std::sync::OnceLock::new(),
            id: next_id(),
            nonzero: crate::alpha::AlphaTable::from_rgba8(width, height, &rgba),
        }
    }

    /// Positive-alpha facts of this same RGBA8 revision, built once with the upload. The
    /// compact table retains no pixel buffer in addition to the lazy opacity input.
    pub fn nonzero(&self) -> Option<&crate::alpha::AlphaTable> {
        self.nonzero.as_ref()
    }

    fn src_bytes(&self) -> Option<crate::SharedBytes> {
        self.src.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The table, built now if it was not.
    fn kind(&self) -> &Kind {
        self.kind.get_or_init(|| {
            let px = self.src.lock().unwrap_or_else(|e| e.into_inner()).take();
            Kind::build(
                self.width,
                self.height,
                px.as_deref().map_or(&[], |v| &v[..]),
            )
        })
    }

    /// The alpha bytes of the level the table covers, row by row (None: the buffer is short, so
    /// no texel is opaque).
    fn scan(&self, f: impl FnMut(u8) -> bool) -> Option<bool> {
        let px = self.src_bytes()?;
        let n = 4 * self.width as usize * self.height as usize;
        if n == 0 || px.len() < n {
            return None;
        }
        Some(px[..n].iter().skip(3).step_by(4).copied().any(f))
    }
}

impl Kind {
    /// The table of a `width × height` straight RGBA8 level 0 ([`Opacity::from_rgba8`]).
    fn build(width: u32, height: u32, rgba: &[u8]) -> Kind {
        let (w, h) = (width as usize, height as usize);
        if w == 0 || h == 0 || rgba.len() < 4 * w * h {
            return Kind::None;
        }
        let bw = w.div_ceil(BLOCK as usize);
        let bh = h.div_ceil(BLOCK as usize);
        // First pass: one opaque-bit row per (block row of texels, block column), written into a
        // dense staging buffer of `bw` words per texel row, then folded per block.
        let mut bits = vec![0u32; bw * h];
        for y in 0..h {
            let row = &rgba[4 * w * y..4 * w * (y + 1)];
            let out = &mut bits[bw * y..bw * (y + 1)];
            for (bx, word) in out.iter_mut().enumerate() {
                let x0 = bx * BLOCK as usize;
                let x1 = (x0 + BLOCK as usize).min(w);
                let px = &row[4 * x0..4 * x1];
                // One branchless pass: bit i set when texel i's alpha byte is 255 (a whole block
                // row at a fixed width, which the compiler turns into byte compares and a mask).
                let mut v = 0u32;
                if let Ok(px) = <&[u8; 4 * BLOCK as usize]>::try_from(px) {
                    for i in 0..BLOCK as usize {
                        v |= u32::from(px[4 * i + 3] == 255) << i;
                    }
                } else {
                    for (i, p) in px.chunks_exact(4).enumerate() {
                        v |= u32::from(p[3] == 255) << i;
                    }
                }
                *word = v;
            }
        }
        let mut blocks = vec![0u32; bw * bh];
        let mut rows: Vec<u32> = Vec::new();
        let (mut any_all, mut any_other) = (false, false);
        for by in 0..bh {
            let y0 = by * BLOCK as usize;
            let y1 = (y0 + BLOCK as usize).min(h);
            for bx in 0..bw {
                let x0 = bx * BLOCK as usize;
                let full = if (w - x0) >= BLOCK as usize {
                    u32::MAX
                } else {
                    (1u32 << (w - x0)) - 1
                };
                let words = (y0..y1).map(|y| bits[bw * y + bx]);
                // An edge block holds only the texture's own texels.
                let all = words.clone().all(|v| v == full);
                let none = words.clone().all(|v| v == 0);
                blocks[by * bw + bx] = if all {
                    any_all = true;
                    ALL
                } else if none {
                    any_other = true;
                    NONE
                } else {
                    any_other = true;
                    let at = rows.len() as u32;
                    rows.extend(words);
                    rows.resize(at as usize + BLOCK as usize, 0);
                    at
                };
            }
        }
        if !any_other {
            Kind::All
        } else if !any_all && rows.is_empty() {
            Kind::None
        } else {
            Kind::Blocks { blocks, rows }
        }
    }
}

impl Opacity {
    /// This table's identity, unique in the process and never 0 (a clone keeps it): a cache of
    /// answers keyed by it can never answer for other texels.
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Every texel is opaque.
    pub fn all(&self) -> bool {
        if let Some(k) = self.kind.get() {
            return matches!(k, Kind::All);
        }
        *self.all.get_or_init(|| match self.scan(|a| a != 255) {
            Some(found) => !found,
            None => matches!(self.kind(), Kind::All),
        })
    }

    /// Some texel is opaque.
    pub fn any(&self) -> bool {
        if let Some(k) = self.kind.get() {
            return !matches!(k, Kind::None);
        }
        *self.any.get_or_init(|| match self.scan(|a| a == 255) {
            Some(found) => found,
            None => !matches!(self.kind(), Kind::None),
        })
    }

    /// Bytes the table holds beyond the struct itself (none until it is built).
    pub fn heap_bytes(&self) -> usize {
        match self.kind.get() {
            Some(Kind::Blocks { blocks, rows }) => 4 * (blocks.capacity() + rows.capacity()),
            _ => 0,
        }
    }

    /// Whether every texel of the inclusive texel rectangle `[x0, x1] × [y0, y1]` is opaque. A
    /// rectangle reaching outside the texture, or an empty one, is not.
    pub fn region(&self, x0: i64, y0: i64, x1: i64, y1: i64) -> bool {
        if x0 > x1 || y0 > y1 || x0 < 0 || y0 < 0 {
            return false;
        }
        if x1 >= i64::from(self.width) || y1 >= i64::from(self.height) {
            return false;
        }
        let (blocks, rows) = match self.kind() {
            Kind::All => return true,
            Kind::None => return false,
            Kind::Blocks { blocks, rows } => (blocks, rows),
        };
        let (x0, y0, x1, y1) = (x0 as u32, y0 as u32, x1 as u32, y1 as u32);
        let bw = self.width.div_ceil(BLOCK);
        for by in y0 / BLOCK..=y1 / BLOCK {
            for bx in x0 / BLOCK..=x1 / BLOCK {
                match blocks[(by * bw + bx) as usize] {
                    ALL => {}
                    NONE => return false,
                    at => {
                        // The texels of this block inside the rectangle.
                        let lx0 = x0.max(bx * BLOCK) - bx * BLOCK;
                        let lx1 = x1.min(bx * BLOCK + BLOCK - 1) - bx * BLOCK;
                        let mask = if lx1 - lx0 + 1 == BLOCK {
                            u32::MAX
                        } else {
                            ((1u32 << (lx1 - lx0 + 1)) - 1) << lx0
                        };
                        let ly0 = y0.max(by * BLOCK) - by * BLOCK;
                        let ly1 = y1.min(by * BLOCK + BLOCK - 1) - by * BLOCK;
                        for ly in ly0..=ly1 {
                            if rows[(at + ly) as usize] & mask != mask {
                                return false;
                            }
                        }
                    }
                }
            }
        }
        true
    }

    /// Whether texel `(x, y)` is opaque (outside the texture: no).
    pub fn texel(&self, x: i64, y: i64) -> bool {
        self.region(x, y, x, y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tex(w: u32, h: u32, transparent: &[(u32, u32)]) -> Vec<u8> {
        let mut v = vec![255u8; (4 * w * h) as usize];
        for &(x, y) in transparent {
            v[(4 * (y * w + x) + 3) as usize] = 254;
        }
        v
    }

    #[test]
    fn all_none_and_mixed() {
        let o = Opacity::from_rgba8(70, 40, &tex(70, 40, &[]));
        assert!(o.all());
        assert!(o.region(0, 0, 69, 39));
        assert!(!o.region(0, 0, 70, 39), "outside the texture");
        let o = Opacity::from_rgba8(3, 3, &[0u8; 36]);
        assert_eq!(*o.kind(), Kind::None);
        assert!(!o.texel(1, 1));
        // One translucent texel at (40, 33): every rectangle holding it fails, its neighbours pass.
        let o = Opacity::from_rgba8(70, 40, &tex(70, 40, &[(40, 33)]));
        assert!(!o.all());
        assert!(!o.region(0, 0, 69, 39));
        assert!(!o.texel(40, 33));
        assert!(o.texel(41, 33) && o.texel(39, 33) && o.texel(40, 32) && o.texel(40, 34));
        assert!(o.region(0, 0, 39, 39));
        assert!(o.region(41, 0, 69, 39));
        assert!(o.region(0, 0, 69, 32));
        assert!(!o.region(40, 33, 69, 39));
        assert!(o.heap_bytes() > 0);
    }

    #[test]
    fn a_lazy_table_answers_as_the_built_one() {
        let shared = |v: Vec<u8>| -> crate::SharedBytes { std::sync::Arc::new(v) };
        let mut cases = vec![
            (70, 40, tex(70, 40, &[])),
            (70, 40, tex(70, 40, &[(40, 33)])),
            (3, 3, vec![0u8; 36]),
            (3, 3, vec![255u8; 35]),
            (0, 3, vec![]),
        ];
        let mut half = tex(77, 45, &[]);
        for (i, a) in half.iter_mut().skip(3).step_by(4).enumerate() {
            *a = if i % 3 == 0 { 255 } else { 17 };
        }
        cases.push((77, 45, half));
        for (w, h, px) in cases {
            let eager = Opacity::from_rgba8(w, h, &px);
            // Asked in either order: before and after the table is built.
            let a = Opacity::lazy(w, h, shared(px.clone()));
            assert_eq!((a.any(), a.all()), (eager.any(), eager.all()), "{w}x{h}");
            assert_eq!(a.heap_bytes(), 0, "not built by any/all");
            let b = Opacity::lazy(w, h, shared(px));
            for r in [
                (0, 0, 69, 39),
                (40, 33, 40, 33),
                (0, 0, 2, 2),
                (5, 5, 30, 20),
            ] {
                assert_eq!(
                    b.region(r.0, r.1, r.2, r.3),
                    eager.region(r.0, r.1, r.2, r.3)
                );
            }
            assert_eq!((b.any(), b.all()), (eager.any(), eager.all()));
            assert_eq!(b, eager);
            assert_ne!(b.id(), eager.id());
        }
    }

    #[test]
    fn region_matches_brute_force() {
        // A pseudo-random sparse pattern on a size that is not a multiple of the block.
        let (w, h) = (77u32, 45u32);
        let mut holes = Vec::new();
        let mut s = 12345u32;
        for _ in 0..9 {
            s = s.wrapping_mul(1_103_515_245).wrapping_add(12345);
            holes.push(((s >> 8) % w, (s >> 20) % h));
        }
        let o = Opacity::from_rgba8(w, h, &tex(w, h, &holes));
        for (x0, y0, x1, y1) in [
            (0, 0, 76, 44),
            (5, 5, 30, 20),
            (31, 0, 33, 44),
            (60, 30, 76, 44),
            (0, 31, 76, 33),
            (10, 10, 10, 10),
        ] {
            let brute = holes
                .iter()
                .all(|&(x, y)| !(x >= x0 && x <= x1 && y >= y0 && y <= y1));
            assert_eq!(
                o.region(x0.into(), y0.into(), x1.into(), y1.into()),
                brute,
                "{x0} {y0} {x1} {y1}"
            );
        }
    }
}
