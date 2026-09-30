use std::collections::HashMap;
#[derive(Default)]
pub struct ResourceStore {
    pub pixels: HashMap<String, (u32, u32, Vec<u8>)>,
    pub dimensions_epoch: u64,
    max_side: Option<u32>,
}
impl ResourceStore {
    pub fn with_max_side(max_side: u32) -> Self {
        Self {
            pixels: HashMap::new(),
            dimensions_epoch: 0,
            max_side: Some(max_side),
        }
    }
    pub fn ready(&self) -> HashMap<String, (u32, u32)> {
        self.pixels
            .iter()
            .map(|(k, (w, h, _))| (k.clone(), (*w, *h)))
            .collect()
    }
    pub fn upload_batch(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        if bytes.len() < 8 || &bytes[0..4] != b"RSR1" {
            return Err("invalid resource header".into());
        }
        let mut cursor = 4;
        let count = read_u32(bytes, &mut cursor)? as usize;
        if count > 4096 {
            return Err("too many resources".into());
        }
        let mut updates = Vec::with_capacity(count);
        for _ in 0..count {
            let key_len = read_u32(bytes, &mut cursor)? as usize;
            let w = read_u32(bytes, &mut cursor)?;
            let h = read_u32(bytes, &mut cursor)?;
            let n = read_u32(bytes, &mut cursor)? as usize;
            if key_len == 0
                || key_len > 4096
                || w == 0
                || h == 0
                || self.max_side.is_some_and(|max| w > max || h > max)
                || w.checked_mul(h)
                    .and_then(|v| v.checked_mul(4))
                    .map(|v| v as usize)
                    != Some(n)
            {
                return Err("invalid resource dimensions".into());
            }
            let key =
                std::str::from_utf8(bytes.get(cursor..cursor + key_len).ok_or("truncated key")?)
                    .map_err(|e| e.to_string())?
                    .to_owned();
            cursor += key_len;
            let pixel = bytes
                .get(cursor..cursor + n)
                .ok_or("truncated pixels")?
                .to_vec();
            cursor += n;
            updates.push((key, (w, h, pixel)));
        }
        if cursor != bytes.len() {
            return Err("trailing resource bytes".into());
        }
        let mut changed = Vec::new();
        for (k, v) in updates {
            if self.pixels.get(&k).map(|old| (old.0, old.1)) != Some((v.0, v.1)) {
                self.dimensions_epoch += 1;
            }
            if self.pixels.get(&k) != Some(&v) {
                changed.push(k.clone());
                self.pixels.insert(k, v);
            }
        }
        Ok(changed)
    }
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
