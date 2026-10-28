//! PM3 (render-stream-11.md "As built (PM3)"): the newest instance buffer of every `ok` /11
//! multimesh, held by multimesh id, for GSW's instanced draws.
//!
//! A /11 transaction carries a multimesh's floats in its `mm_f32` block only when they changed
//! (PM1 rule 3); [`crate::validate::Validator::multimesh_buffers`] locates the buffers of the
//! transaction just accepted, and an `ok` entry not listed kept its floats. The adapter calls
//! [`MultimeshBuffers::ingest`] right after every accepted transaction, while the record's bytes
//! are in hand (a live message buffer is reused by the next message), as it ingests dynamic mesh
//! bodies (W11c). One buffer per multimesh the newest state holds as `ok`, so the store is bounded
//! by the state, never by the frames seen. A credit-window-2 fold needs nothing more: the later
//! transaction's buffer replaces the earlier one, and an unlisted entry keeps it.

use crate::state::{EntryStatus, Id, ResolvedState};
use crate::validate::MmBufferRef;

/// One multimesh's newest buffer: the wire's floats, bit for bit, and the ingest serial that set
/// them (an applier rewrites the instances it drew from a buffer whose serial moved).
#[derive(Clone, Debug, Default)]
pub struct MmBuffer {
    pub floats: Vec<f32>,
    pub serial: u64,
}

#[derive(Default)]
pub struct MultimeshBuffers {
    map: super::IdMap<MmBuffer>,
    serial: u64,
    /// Buffers ingested since the session began, and their bytes (evidence).
    pub buffers_total: u64,
    pub bytes_total: u64,
    /// Multimeshes first held, and dropped, since the session began (evidence).
    pub created_total: u64,
    pub freed_total: u64,
}

impl MultimeshBuffers {
    pub fn clear(&mut self) {
        *self = MultimeshBuffers::default();
    }

    /// Multimeshes held.
    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Bytes held (4 per float).
    pub fn bytes(&self) -> u64 {
        self.map.values().map(|b| 4 * b.floats.len() as u64).sum()
    }

    pub fn get(&self, id: Id) -> Option<&MmBuffer> {
        self.map.get(&id)
    }

    /// The accepted transaction's buffers (`refs`, sliced from `record`); then every multimesh
    /// the new state does not hold as `ok` is dropped.
    pub fn ingest(&mut self, state: &ResolvedState, refs: &[MmBufferRef], record: &[u8]) {
        for r in refs {
            self.serial += 1;
            let bytes = r.bytes(record);
            self.buffers_total += 1;
            self.bytes_total += bytes.len() as u64;
            if !self.map.contains_key(&r.multimesh) {
                self.created_total += 1;
            }
            let e = self.map.entry(r.multimesh).or_default();
            e.floats.clear();
            e.floats.extend(
                bytes
                    .chunks_exact(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])),
            );
            e.serial = self.serial;
        }
        if !self.map.is_empty() {
            let before = self.map.len();
            self.map.retain(|id, _| {
                state
                    .multimeshes
                    .get(id)
                    .is_some_and(|m| m.status == EntryStatus::Ok)
            });
            self.freed_total += (before - self.map.len()) as u64;
        }
    }
}
