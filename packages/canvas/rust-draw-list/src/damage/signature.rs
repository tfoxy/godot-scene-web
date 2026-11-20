use super::{back, cover, BoundsFacts, DamageFacts};
use crate::cover::PxRect;
use crate::{
    DrawList, UniformValue, BUILTIN_PROGRAM, DRAW_INSTANCED, DRAW_SCISSOR, DRAW_SCREEN_OPS,
};

/// Word hash with a rotate/multiply avalanche; all variable-length fields are length-prefixed.
#[derive(Clone, Copy)]
pub(super) struct Hash(pub u64);
impl Hash {
    pub fn new() -> Self {
        Self(0x517c_c1b7_2722_0a95)
    }
    pub fn word(&mut self, v: u64) {
        self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    pub fn bytes(&mut self, bytes: &[u8]) {
        self.word(bytes.len() as u64);
        for chunk in bytes.chunks(8) {
            let mut word = [0; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.word(u64::from_le_bytes(word));
        }
    }
}

#[derive(Clone)]
pub(super) struct DrawSig {
    pub hash: u64,
    pub bounds: PxRect,
    pub is_op: bool,
}
pub(super) struct Snapshot {
    pub target: [u32; 9],
    pub draws: Vec<DrawSig>,
    pub draw_count: usize,
    pub replay: Vec<(PxRect, bool)>,
    pub back: back::Analysis,
}

pub(super) fn draw_hash(list: &DrawList, d: usize, facts: &impl DamageFacts) -> Hash {
    let draw = &list.draws[d];
    let mut h = Hash::new();
    h.word(0xd0);
    for v in [
        draw.texture,
        facts.texture_revision(draw.texture),
        draw.sampler,
        draw.blend,
        draw.program,
        draw.flags & !DRAW_SCREEN_OPS,
        draw.msdf[0].to_bits(),
        draw.msdf[1].to_bits(),
    ] {
        h.word(u64::from(v));
    }
    if draw.flags & DRAW_SCISSOR != 0 {
        for v in draw.scissor {
            h.word(v as u64);
        }
    }
    h.word(u64::from(facts.admitted(list, d)));
    // Absolute vertex/item addresses are storage, not content. Preserve the relative index
    // pattern while replacing every item address with the complete referenced row.
    let from = (draw.first_index as usize).min(list.indices.len());
    let to = (from + draw.index_count as usize).min(list.indices.len());
    let indices = &list.indices[from..to];
    let base = indices.iter().copied().min().unwrap_or(0);
    h.word(indices.len() as u64);
    for &i in indices {
        h.word(u64::from(i - base));
        if let Some(v) = list.vertices.get(i as usize) {
            h.word(1);
            h.bytes(bytemuck::cast_slice(&v.pos));
            h.bytes(bytemuck::cast_slice(&v.uv));
            h.bytes(bytemuck::cast_slice(&v.color));
            if let Some(item) = list.items.get(v.item as usize) {
                h.word(1);
                h.bytes(bytemuck::bytes_of(item));
            } else {
                h.word(0);
            }
        } else {
            h.word(0);
        }
    }
    if draw.flags & DRAW_INSTANCED != 0 {
        if let Ok(i) = list.instanced.binary_search_by_key(&(d as u32), |r| r.draw) {
            let r = list.instanced[i];
            let from = (r.first as usize).min(list.instances.len());
            let to = (from + r.count as usize).min(list.instances.len());
            h.bytes(bytemuck::cast_slice(&list.instances[from..to]));
        } else {
            h.word(0);
        }
    }
    if draw.program != BUILTIN_PROGRAM {
        let slot = draw.program - 1;
        let p = facts.program(slot);
        h.word(u64::from(p.reads_screen));
        h.word(u64::from(p.vertex_stage));
        h.word(u64::from(facts.program_revision(slot)));
        if let Some(b) = list.bindings.get(slot as usize) {
            h.word(1);
            h.word(u64::from(b.program));
            h.bytes(bytemuck::cast_slice(&b.post_modulate));
            h.word(b.uniforms.len() as u64);
            for u in &b.uniforms {
                h.bytes(u.name.as_bytes());
                match &u.value {
                    UniformValue::Float(v) => {
                        h.word(0);
                        h.bytes(bytemuck::cast_slice(v));
                    }
                    UniformValue::Int(v) => {
                        h.word(1);
                        h.bytes(bytemuck::cast_slice(v));
                    }
                }
            }
            h.word(b.samplers.len() as u64);
            for s in &b.samplers {
                h.bytes(s.name.as_bytes());
                h.word(u64::from(s.texture));
                h.word(u64::from(facts.texture_revision(s.texture)));
                h.word(u64::from(s.sampler));
            }
        } else {
            h.word(0);
        }
        h.word(u64::from(facts.reads_time(slot)));
        if facts.reads_time(slot) {
            h.word(u64::from(list.shader_time.to_bits()));
        }
    }
    h
}

pub(super) fn snapshot(list: &DrawList, facts: &impl DamageFacts) -> Snapshot {
    let t = list.target;
    let bounds: Vec<_> = (0..list.draws.len())
        .map(|d| cover::draw_bounds(list, d, &BoundsFacts(facts)))
        .collect();
    let mut draws = Vec::new();
    let mut bb = Hash::new();
    // Clearing level zero does not clear already-built mip levels. Keep their input identity
    // separately so a later mip reader still observes changes to those inputs.
    let mut mips = Hash::new();
    let mut sample_mips = false;
    let mut next_op = 0;
    let last = list
        .draws
        .iter()
        .enumerate()
        .rfind(|(d, draw)| draw.index_count > 0 && facts.admitted(list, *d))
        .map(|(d, _)| d);
    let target = PxRect::xywh([0, 0, t.width as i32, t.height as i32]);
    for (d, draw) in list.draws.iter().enumerate() {
        while let Some(op) = list.screen_ops.get(next_op) {
            if op.before as usize > d || last.is_none_or(|last| d > last) {
                break;
            }
            next_op += 1;
            if op.kind == crate::ScreenOpKind::Clear {
                bb = Hash::new();
            }
            let mut op_hash = Hash::new();
            op_hash.word(0x5c);
            op_hash.word(op.kind as u64);
            for v in op.region {
                op_hash.word(v as u64);
            }
            op_hash.word(u64::from(op.mipmaps));
            op_hash.word(u64::from(op.sample_mips));
            bb.word(op_hash.0);
            // Execution position is represented by ordering, not by the storage draw index.
            // Moving a copy across a target draw must unmatch at least one of those entries.
            draws.push(DrawSig {
                hash: op_hash.0,
                // Copy reads target pixels, so moving it must damage its source region.
                // Clear and Mipmaps only write the back buffer: bb/mips identities already
                // carry their effects into every later reader's signature, including when
                // Clear moves across a producer. They have no target damage of their own.
                bounds: if op.kind == crate::ScreenOpKind::Copy {
                    PxRect::xywh(op.region).intersect(&target)
                } else {
                    PxRect::EMPTY
                },
                is_op: true,
            });
            sample_mips = op.sample_mips;
            if op.region[2] > 0
                && op.region[3] > 0
                && (op.kind == crate::ScreenOpKind::Mipmaps
                    || (op.kind == crate::ScreenOpKind::Copy && op.mipmaps))
            {
                mips.word(bb.0);
            }
        }
        let mut h = draw_hash(list, d, facts);
        if draw.flags & crate::DRAW_TO_BACK_BUFFER != 0 {
            bb.word(0xbb);
            bb.word(h.0);
        }
        if back::reader(list, d, facts) {
            h.word(bb.0);
            if sample_mips {
                h.word(mips.0);
            }
        }
        draws.push(DrawSig {
            hash: h.0,
            bounds: bounds[d],
            is_op: false,
        });
    }
    Snapshot {
        target: [
            t.width,
            t.height,
            t.format as u32,
            t.clear[0].to_bits(),
            t.clear[1].to_bits(),
            t.clear[2].to_bits(),
            t.clear[3].to_bits(),
            u32::from(t.opaque),
            t.surface,
        ],
        draw_count: list.draws.len(),
        replay: bounds
            .iter()
            .enumerate()
            .map(|(d, b)| (*b, facts.admitted(list, d)))
            .collect(),
        back: back::Analysis::new(list, facts, &bounds),
        draws,
    }
}
