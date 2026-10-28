//! PM2 (render-stream-11.md "As built (PM2)"): the newest instance buffer of every `ok` /11
//! multimesh, ingested at accept as W11d ingests dynamic bodies. `Validator::multimesh_buffers()`
//! names the buffers the transaction just accepted carried (a live message buffer is reused, so
//! they are copied here before `rsc_accept` returns); an `ok` entry not listed kept its floats.
//! The planner re-sends a buffer to the RenderingServer when its serial moved.

use render_stream_core::state::{EntryStatus, Id, ResolvedState};
use render_stream_core::validate::MmBufferRef;
use std::collections::HashMap;

/// One multimesh's buffer: its little-endian f32 bytes, exactly the wire's, and a serial that
/// moves with every ingest.
#[derive(Debug, Clone)]
pub struct MmBuffer {
    pub bytes: Vec<u8>,
    pub serial: u64,
}

#[derive(Default, Debug)]
pub struct MmStore {
    map: HashMap<Id, MmBuffer>,
    next_serial: u64,
    /// Buffers and bytes ingested since the session began (evidence).
    pub buffers_total: u64,
    pub bytes_total: u64,
}

impl MmStore {
    pub fn clear(&mut self) {
        *self = MmStore::default();
    }

    /// The accepted transaction's buffers (`refs`, sliced from `record`), then forgets every
    /// multimesh the resolved state no longer holds as `ok`.
    pub fn ingest(&mut self, st: &ResolvedState, refs: &[MmBufferRef], record: &[u8]) {
        for r in refs {
            self.next_serial += 1;
            let bytes = r.bytes(record);
            self.buffers_total += 1;
            self.bytes_total += bytes.len() as u64;
            let e = self.map.entry(r.multimesh).or_insert(MmBuffer {
                bytes: Vec::new(),
                serial: 0,
            });
            e.bytes.clear();
            e.bytes.extend_from_slice(bytes);
            e.serial = self.next_serial;
        }
        if !self.map.is_empty() {
            self.map.retain(|id, _| {
                st.multimeshes
                    .get(id)
                    .is_some_and(|m| m.status == EntryStatus::Ok)
            });
        }
    }

    pub fn get(&self, id: Id) -> Option<&MmBuffer> {
        self.map.get(&id)
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// The bytes held (evidence).
    pub fn bytes(&self) -> usize {
        self.map.values().map(|b| b.bytes.len()).sum()
    }
}
