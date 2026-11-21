//! Which texels of a straight RGBA8 texture are fully opaque (alpha 255), kept compactly so a
//! caller can ask whether a texel rectangle is opaque throughout (an atlas region, say).
//!
//! Built once per texture from its level-0 bytes ([`Opacity::from_rgba8`]), or on the first
//! question that needs each block ([`Opacity::lazy`]: most textures are never asked about a
//! rectangle, and whether a texture has an opaque texel, or only opaque ones, is answered by a
//! scan that stops at the first texel that decides it). The texture is cut into
//! [`BLOCK`]×[`BLOCK`] blocks: a block whose every texel is opaque or whose every texel is not
//! needs no bit rows, and only a block holding both keeps one bit per texel. Eager tables use one word per block; demand tables use one initialization cell. A query
//! is exact: it reads the table and, for mixed blocks, the bit rows.

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
        // Snapshot the unpublished source under the same lock initialization takes. If it
        // already took the source, wait for its table rather than cloning an empty revision.
        let src = self.src.lock().unwrap_or_else(|e| e.into_inner());
        let mut kind = self.kind.clone();
        let pixels = src.clone();
        drop(src);
        if pixels.is_none() && kind.get().is_none() {
            kind = self.kind().clone().into();
        }
        Opacity {
            width: self.width,
            height: self.height,
            kind,
            src: std::sync::Mutex::new(pixels),
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
        if self.width != o.width || self.height != o.height {
            return false;
        }
        self.canonical() == o.canonical()
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
    /// A revision's demanded blocks; clones share the cache and its source-byte lifetime.
    Demand(std::sync::Arc<Demand>),
}

#[derive(Debug)]
struct Demand {
    blocks: Vec<std::sync::OnceLock<Block>>,
    src: std::sync::Mutex<Option<crate::SharedBytes>>,
    unresolved: std::sync::atomic::AtomicUsize,
}

#[derive(Debug)]
enum Block {
    All,
    None,
    Mixed(Box<[u32; BLOCK as usize]>),
}

impl PartialEq for Demand {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(self, other)
    }
}

impl Eq for Demand {}

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

    /// [`Opacity::from_rgba8`] of `rgba`, built one queried block at a time. It holds shared
    /// pixels until every block has been resolved; clones share an initialized block cache.
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
        self.src
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .or_else(|| {
                if let Some(Kind::Demand(d)) = self.kind.get() {
                    d.src.lock().unwrap_or_else(|e| e.into_inner()).clone()
                } else {
                    None
                }
            })
    }

    fn canonical(&self) -> std::borrow::Cow<'_, Kind> {
        match self.kind() {
            Kind::Demand(d) => std::borrow::Cow::Owned(d.materialize(self.width, self.height)),
            k => std::borrow::Cow::Borrowed(k),
        }
    }

    /// The table, allocated now if it was not; lazy texels are read per demanded block.
    fn kind(&self) -> &Kind {
        self.kind.get_or_init(|| {
            let px = self.src.lock().unwrap_or_else(|e| e.into_inner()).take();
            let Some(px) = px else {
                return Kind::None;
            };
            let (w, h) = (self.width as usize, self.height as usize);
            if w == 0 || h == 0 || px.len() < 4 * w * h {
                return Kind::None;
            }
            let n = w.div_ceil(BLOCK as usize) * h.div_ceil(BLOCK as usize);
            Kind::Demand(std::sync::Arc::new(Demand {
                blocks: (0..n).map(|_| std::sync::OnceLock::new()).collect(),
                src: std::sync::Mutex::new(Some(px)),
                unresolved: std::sync::atomic::AtomicUsize::new(n),
            }))
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

impl Demand {
    fn block(&self, width: u32, height: u32, i: usize) -> &Block {
        self.blocks[i].get_or_init(|| {
            let src = self
                .src
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
                .expect("unresolved opacity block retains source bytes");
            let bw = width.div_ceil(BLOCK) as usize;
            let x0 = (i % bw) * BLOCK as usize;
            let y0 = (i / bw) * BLOCK as usize;
            let x1 = (x0 + BLOCK as usize).min(width as usize);
            let y1 = (y0 + BLOCK as usize).min(height as usize);
            let full = u32::MAX >> (BLOCK as usize - (x1 - x0));
            let mut rows = [0u32; BLOCK as usize];
            for y in y0..y1 {
                let start = 4 * (y * width as usize + x0);
                let px = &src[start..start + 4 * (x1 - x0)];
                let mut v = 0;
                if let Ok(px) = <&[u8; 4 * BLOCK as usize]>::try_from(px) {
                    for x in 0..BLOCK as usize {
                        v |= u32::from(px[4 * x + 3] == 255) << x;
                    }
                } else {
                    for (x, p) in px.chunks_exact(4).enumerate() {
                        v |= u32::from(p[3] == 255) << x;
                    }
                }
                rows[y - y0] = v;
            }
            let live = &rows[..y1 - y0];
            let block = if live.iter().all(|&v| v == full) {
                Block::All
            } else if live.iter().all(|&v| v == 0) {
                Block::None
            } else {
                Block::Mixed(Box::new(rows))
            };
            // Every initializer already owns its shared bytes before decrementing. The last
            // initializer can release the cache's source even while another publishes its cell.
            if self
                .unresolved
                .fetch_sub(1, std::sync::atomic::Ordering::AcqRel) == 1
            {
                self.src.lock().unwrap_or_else(|e| e.into_inner()).take();
            }
            block
        })
    }

    fn region(&self, width: u32, height: u32, x0: u32, y0: u32, x1: u32, y1: u32) -> bool {
        let bw = width.div_ceil(BLOCK);
        for by in y0 / BLOCK..=y1 / BLOCK {
            for bx in x0 / BLOCK..=x1 / BLOCK {
                match self.block(width, height, (by * bw + bx) as usize) {
                    Block::All => {}
                    Block::None => return false,
                    Block::Mixed(rows) => {
                        let lx0 = x0.max(bx * BLOCK) - bx * BLOCK;
                        let lx1 = x1.min(bx * BLOCK + BLOCK - 1) - bx * BLOCK;
                        let mask = (u32::MAX >> (BLOCK - (lx1 - lx0 + 1))) << lx0;
                        let ly0 = y0.max(by * BLOCK) - by * BLOCK;
                        let ly1 = y1.min(by * BLOCK + BLOCK - 1) - by * BLOCK;
                        for ly in ly0..=ly1 {
                            if rows[ly as usize] & mask != mask {
                                return false;
                            }
                        }
                    }
                }
            }
        }
        true
    }

    fn materialize(&self, width: u32, height: u32) -> Kind {
        let mut blocks = Vec::with_capacity(self.blocks.len());
        let mut rows = Vec::new();
        for i in 0..self.blocks.len() {
            blocks.push(match self.block(width, height, i) {
                Block::All => ALL,
                Block::None => NONE,
                Block::Mixed(bits) => {
                    let at = rows.len() as u32;
                    rows.extend_from_slice(&bits[..]);
                    at
                }
            });
        }
        if blocks.iter().all(|&b| b == ALL) {
            Kind::All
        } else if blocks.iter().all(|&b| b == NONE) {
            Kind::None
        } else {
            Kind::Blocks { blocks, rows }
        }
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
            if !matches!(k, Kind::Demand(_)) {
                return matches!(k, Kind::All);
            }
        }
        *self.all.get_or_init(|| match self.scan(|a| a != 255) {
            Some(found) => !found,
            None => match self.kind() {
                Kind::Demand(d) => (0..d.blocks.len()).all(|i| {
                    matches!(d.block(self.width, self.height, i), Block::All)
                }),
                k => matches!(k, Kind::All),
            },
        })
    }

    /// Some texel is opaque.
    pub fn any(&self) -> bool {
        if let Some(k) = self.kind.get() {
            if !matches!(k, Kind::Demand(_)) {
                return !matches!(k, Kind::None);
            }
        }
        *self.any.get_or_init(|| match self.scan(|a| a == 255) {
            Some(found) => found,
            None => match self.kind() {
                Kind::Demand(d) => (0..d.blocks.len()).any(|i| {
                    !matches!(d.block(self.width, self.height, i), Block::None)
                }),
                k => !matches!(k, Kind::None),
            },
        })
    }

    /// Bytes allocated by the table beyond this struct (none before the first region query).
    /// Shared revision caches are reported in full by each clone; shared pixels are excluded.
    pub fn heap_bytes(&self) -> usize {
        match self.kind.get() {
            Some(Kind::Blocks { blocks, rows }) => 4 * (blocks.capacity() + rows.capacity()),
            Some(Kind::Demand(d)) => {
                std::mem::size_of::<Demand>()
                    + 2 * std::mem::size_of::<usize>()
                    + d.blocks.capacity() * std::mem::size_of::<std::sync::OnceLock<Block>>()
                    + d.blocks
                        .iter()
                        .filter_map(|b| b.get())
                        .map(|b| match b {
                            Block::Mixed(_) => 4 * BLOCK as usize,
                            _ => 0,
                        })
                        .sum::<usize>()
            }
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
            Kind::Demand(d) => {
                return d.region(
                    self.width, self.height, x0 as u32, y0 as u32, x1 as u32, y1 as u32,
                );
            }
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
    fn lazy_regions_retain_pixels_for_unqueried_blocks() {
        let pixels = std::sync::Arc::new(tex(96, 64, &[(0, 0)]));
        let weak = std::sync::Arc::downgrade(&pixels);
        let o = Opacity::lazy(96, 64, pixels);
        assert!(!o.region(0, 0, 95, 63));
        assert!(weak.upgrade().is_some(), "unqueried blocks still need pixels");
        let clone = o.clone();
        assert_eq!(clone.id(), o.id());
        drop(o);
        assert!(clone.region(32, 0, 95, 63));
        assert!(clone.region(0, 32, 31, 63));
        assert!(weak.upgrade().is_none(), "all blocks resolved: release pixels");
        assert!(!clone.all());
        assert!(clone.any());
    }

    fn demanded(o: &Opacity) -> &Demand {
        let Kind::Demand(d) = o.kind.get().expect("queried table") else {
            panic!("expected demand table");
        };
        d
    }

    #[test]
    fn lazy_region_stops_at_a_disproving_block_and_caches_the_revision() {
        let o = Opacity::lazy(96, 64, std::sync::Arc::new(tex(96, 64, &[(0, 0)])));
        assert!(!o.region(0, 0, 95, 63));
        let d = demanded(&o);
        assert!(d.blocks[0].get().is_some());
        assert!(d.blocks[1..].iter().all(|b| b.get().is_none()));
        let bytes = o.heap_bytes();
        for _ in 0..10 {
            assert!(!o.region(0, 0, 95, 63));
        }
        assert_eq!(o.heap_bytes(), bytes);
        assert_eq!(
            d.unresolved.load(std::sync::atomic::Ordering::Relaxed),
            5
        );
        let clone = o.clone();
        assert!(std::sync::Arc::ptr_eq(
            match o.kind() {
                Kind::Demand(d) => d,
                _ => unreachable!(),
            },
            match clone.kind() {
                Kind::Demand(d) => d,
                _ => unreachable!(),
            },
        ));
        assert_eq!(clone.heap_bytes(), o.heap_bytes());
        let revision = Opacity::lazy(96, 64, std::sync::Arc::new(tex(96, 64, &[])));
        assert_ne!(revision.id(), o.id());
        assert!(revision.region(0, 0, 95, 63));
        assert!(!clone.texel(0, 0));
    }

    #[test]
    fn lazy_edge_masks_and_short_buffers_match_eager() {
        let (w, h) = (35, 34);
        let mut px = tex(w, h, &[(32, 32), (34, 33), (31, 31)]);
        px[(4 * (33 * w + 33) + 3) as usize] = 0;
        let eager = Opacity::from_rgba8(w, h, &px);
        let o = Opacity::lazy(w, h, std::sync::Arc::new(px));
        for y0 in 30..h {
            for y1 in y0..h {
                for x0 in 30..w {
                    for x1 in x0..w {
                        assert_eq!(
                            o.region(x0.into(), y0.into(), x1.into(), y1.into()),
                            eager.region(x0.into(), y0.into(), x1.into(), y1.into())
                        );
                    }
                }
            }
        }
        for r in [
            (-1, 0, 1, 1),
            (0, -1, 1, 1),
            (0, 0, 35, 33),
            (0, 0, 34, 34),
            (2, 0, 1, 1),
            (0, 2, 1, 1),
        ] {
            assert!(!o.region(r.0, r.1, r.2, r.3));
        }
        let short = Opacity::lazy(
            w, h, std::sync::Arc::new(vec![255; (4 * w * h - 1) as usize]),
        );
        assert!(!short.texel(0, 0));
        assert!(!short.any());
        assert!(!short.all());
        assert_eq!(short.heap_bytes(), 0);
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
