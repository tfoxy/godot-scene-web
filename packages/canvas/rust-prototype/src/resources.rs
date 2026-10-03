use std::collections::{HashMap, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};

/// Pixel data is returned to the GPU uploader and dropped after queue writes; only residency facts remain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResourceFormat {
    Srgb,
    Linear,
}
impl ResourceFormat {
    fn from_byte(value: u8) -> Result<Self, String> {
        match value {
            0 => Ok(Self::Srgb),
            1 => Ok(Self::Linear),
            _ => Err("unsupported resource format".into()),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceMeta {
    pub width: u32,
    pub height: u32,
    pub format: ResourceFormat,
    fingerprint: Option<u64>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum ResourceChange {
    Allocate {
        key: String,
        width: u32,
        height: u32,
        format: ResourceFormat,
    },
    Replace {
        key: String,
        width: u32,
        height: u32,
        format: ResourceFormat,
        pixels: Vec<u8>,
    },
    Subrect {
        key: String,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        pixels: Vec<u8>,
    },
    Release {
        key: String,
    },
}
impl ResourceChange {
    pub fn key(&self) -> &str {
        match self {
            Self::Allocate { key, .. }
            | Self::Replace { key, .. }
            | Self::Subrect { key, .. }
            | Self::Release { key } => key,
        }
    }
    pub fn byte_len(&self) -> usize {
        match self {
            Self::Replace { pixels, .. } | Self::Subrect { pixels, .. } => pixels.len(),
            Self::Allocate { .. } | Self::Release { .. } => 0,
        }
    }
}
pub struct ResourceBatch {
    pub changes: Vec<ResourceChange>,
    staged: HashMap<String, Option<ResourceMeta>>,
    dimensions_epoch: u64,
}
#[derive(Default)]
pub struct ResourceStore {
    pub entries: HashMap<String, ResourceMeta>,
    /// Moves when a resident key is resized or released, never for a new key: it says whether a committed
    /// scene's resources may have stopped matching what is resident.
    pub dimensions_epoch: u64,
    max_side: Option<u32>,
}
impl crate::contract::ReadyResources for ResourceStore {
    fn ready_size(&self, key: &str) -> Option<(u32, u32)> {
        self.entries.get(key).map(|entry| (entry.width, entry.height))
    }
}
impl ResourceStore {
    pub fn with_max_side(max_side: u32) -> Self {
        Self {
            entries: HashMap::new(),
            dimensions_epoch: 0,
            max_side: Some(max_side),
        }
    }
    pub fn ready(&self) -> HashMap<String, (u32, u32)> {
        self.entries
            .iter()
            .map(|(k, v)| (k.clone(), (v.width, v.height)))
            .collect()
    }
    pub fn upload_batch(&mut self, bytes: &[u8]) -> Result<Vec<ResourceChange>, String> {
        let batch = self.plan_batch(bytes)?;
        Ok(self.commit_batch(batch))
    }
    pub fn commit_batch(&mut self, batch: ResourceBatch) -> Vec<ResourceChange> {
        for (key, value) in batch.staged {
            if let Some(meta) = value {
                self.entries.insert(key, meta);
            } else {
                self.entries.remove(&key);
            }
        }
        self.dimensions_epoch = batch.dimensions_epoch;
        batch.changes
    }
    /** Validate without publishing residency; GPU uploads can commit only after success. */
    pub fn plan_batch(&self, bytes: &[u8]) -> Result<ResourceBatch, String> {
        if bytes.len() < 8 {
            return Err("invalid resource header".into());
        }
        let is_v2 = match &bytes[..4] {
            b"RSR1" => false,
            b"RSR2" => true,
            _ => return Err("invalid resource header".into()),
        };
        let mut cursor = 4;
        let count = read_u32(bytes, &mut cursor)? as usize;
        if count > 4096 {
            return Err("too many resources".into());
        }
        // Stage only keys touched by this batch. Validation can inspect earlier operations on
        // the same key without cloning every resident page or changing committed metadata.
        let mut staged: HashMap<String, Option<ResourceMeta>> = HashMap::new();
        let mut updates = Vec::with_capacity(count);
        let mut epoch = self.dimensions_epoch;
        for _ in 0..count {
            let (operation, format, key_len, w, h, x, y, rw, rh, n) = if is_v2 {
                let header = bytes
                    .get(cursor..cursor + 4)
                    .ok_or("truncated resource header")?;
                cursor += 4;
                if header[2] != 0 || header[3] != 0 {
                    return Err("invalid resource flags".into());
                }
                (
                    header[0],
                    ResourceFormat::from_byte(header[1])?,
                    read_u32(bytes, &mut cursor)? as usize,
                    read_u32(bytes, &mut cursor)?,
                    read_u32(bytes, &mut cursor)?,
                    read_u32(bytes, &mut cursor)?,
                    read_u32(bytes, &mut cursor)?,
                    read_u32(bytes, &mut cursor)?,
                    read_u32(bytes, &mut cursor)?,
                    read_u32(bytes, &mut cursor)? as usize,
                )
            } else {
                let key_len = read_u32(bytes, &mut cursor)? as usize;
                let w = read_u32(bytes, &mut cursor)?;
                let h = read_u32(bytes, &mut cursor)?;
                let n = read_u32(bytes, &mut cursor)? as usize;
                (0, ResourceFormat::Srgb, key_len, w, h, 0, 0, w, h, n)
            };
            if key_len == 0 || key_len > 4096 {
                return Err("invalid resource key".into());
            }
            let key =
                std::str::from_utf8(bytes.get(cursor..cursor + key_len).ok_or("truncated key")?)
                    .map_err(|e| e.to_string())?
                    .to_owned();
            cursor += key_len;
            let pixels = bytes
                .get(cursor..cursor + n)
                .ok_or("truncated pixels")?
                .to_vec();
            cursor += n;
            match operation {
                0 => {
                    if w == 0
                        || h == 0
                        || rw != w
                        || rh != h
                        || x != 0
                        || y != 0
                        || self.max_side.is_some_and(|max| w > max || h > max)
                        || rgba_len(w, h) != Some(n)
                    {
                        return Err("invalid resource dimensions".into());
                    }
                    let hash = fingerprint(&pixels);
                    let previous = staged
                        .get(&key)
                        .map(Option::as_ref)
                        .unwrap_or_else(|| self.entries.get(&key));
                    let changed = previous.is_none_or(|old| {
                        old.width != w
                            || old.height != h
                            || old.format != format
                            || old.fingerprint != Some(hash)
                    });
                    // The epoch tracks what a committed scene may rely on: a resident key's size. A new key
                    // cannot invalidate a scene that does not name it yet (admitting one checks it anyway).
                    if previous.is_some_and(|old| old.width != w || old.height != h) {
                        epoch += 1;
                    }
                    staged.insert(
                        key.clone(),
                        Some(ResourceMeta {
                            width: w,
                            height: h,
                            format,
                            fingerprint: Some(hash),
                        }),
                    );
                    if changed {
                        updates.push(ResourceChange::Replace {
                            key,
                            width: w,
                            height: h,
                            format,
                            pixels,
                        });
                    }
                }
                1 if is_v2 => {
                    let old = staged
                        .get(&key)
                        .map(Option::as_ref)
                        .unwrap_or_else(|| self.entries.get(&key))
                        .ok_or("subrect resource missing")?;
                    if old.width != w
                        || old.height != h
                        || old.format != format
                        || rw == 0
                        || rh == 0
                        || x.checked_add(rw).is_none_or(|end| end > w)
                        || y.checked_add(rh).is_none_or(|end| end > h)
                        || rgba_len(rw, rh) != Some(n)
                    {
                        return Err("invalid resource subrect".into());
                    }
                    let mut changed = old.clone();
                    changed.fingerprint = None;
                    staged.insert(key.clone(), Some(changed));
                    updates.push(ResourceChange::Subrect {
                        key,
                        x,
                        y,
                        width: rw,
                        height: rh,
                        pixels,
                    });
                }
                2 if is_v2 => {
                    if w != 0 || h != 0 || x != 0 || y != 0 || rw != 0 || rh != 0 || n != 0 {
                        return Err("invalid resource release".into());
                    }
                    let present = staged
                        .get(&key)
                        .map(Option::as_ref)
                        .unwrap_or_else(|| self.entries.get(&key))
                        .is_some();
                    staged.insert(key.clone(), None);
                    if present {
                        epoch += 1;
                        updates.push(ResourceChange::Release { key });
                    }
                }
                3 if is_v2 => {
                    if w == 0
                        || h == 0
                        || x != 0
                        || y != 0
                        || rw != 0
                        || rh != 0
                        || n != 0
                        || self.max_side.is_some_and(|max| w > max || h > max)
                        || rgba_len(w, h).is_none()
                        || self.entries.contains_key(&key)
                        || staged.contains_key(&key)
                    {
                        return Err("invalid or duplicate resource allocation".into());
                    }
                    staged.insert(
                        key.clone(),
                        Some(ResourceMeta {
                            width: w,
                            height: h,
                            format,
                            fingerprint: None,
                        }),
                    );
                    // A fresh key: nothing committed names it (see Replace above).
                    updates.push(ResourceChange::Allocate {
                        key,
                        width: w,
                        height: h,
                        format,
                    });
                }
                _ => return Err("invalid resource operation".into()),
            }
        }
        if cursor != bytes.len() {
            return Err("trailing resource bytes".into());
        }
        Ok(ResourceBatch {
            changes: updates,
            staged,
            dimensions_epoch: epoch,
        })
    }
}
fn rgba_len(w: u32, h: u32) -> Option<usize> {
    w.checked_mul(h)?.checked_mul(4).map(|v| v as usize)
}
fn fingerprint(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}
fn read_u32(bytes: &[u8], c: &mut usize) -> Result<u32, String> {
    let a: [u8; 4] = bytes
        .get(*c..*c + 4)
        .ok_or("truncated resource header")?
        .try_into()
        .unwrap();
    *c += 4;
    Ok(u32::from_le_bytes(a))
}
