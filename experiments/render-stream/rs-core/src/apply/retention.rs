//! W11c (render-stream-11.md "Receiver retention", "Receivers"): a /11 receiver's payload store
//! holds the retention set H = names(S_d) ∪ C ∪ names(S_n) and nothing else, where S_n is the
//! newest accepted state, C the validator's carried set and S_d the state the receiver displays
//! (behind S_n between an accept and its apply, and over a credit-window-2 fold).
//!
//! The validator reports, after each accepted transaction, the hashes that left C ∪ names(S_n)
//! ([`Validator::released`]). [`Retention::note`] queues them, and [`Retention::sweep`] drops each
//! queued hash that is back in names(S_n) or C (it returned: keep it) or that the display does not
//! hold. A hash the display still draws from stays queued until a later sweep (after the apply that
//! moves S_d). Below /11 `released()` is empty, so nothing is ever queued and the store behaves as
//! at /10.
//!
//! An adapter (GSW's `gsw-rs`; W11d's `rs-core-capi` planner and W11e's web export) calls `note`
//! after every accepted transaction and `sweep` after every accept and after every apply.

use super::payloads::PayloadStore;
use crate::state::Hash;
use crate::validate::Validator;
use std::collections::HashSet;

#[derive(Default)]
pub struct Retention {
    /// Hashes that left C ∪ names(S_n), not yet dropped (the display may still hold them).
    pending: Vec<Hash>,
    /// Store entries dropped by the rule since the session began.
    pub released_total: u64,
}

impl Retention {
    pub fn clear(&mut self) {
        self.pending.clear();
        self.released_total = 0;
    }

    /// Queued hashes (left C ∪ names(S_n), still held for the display or not yet swept).
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Queue the last accepted transaction's [`Validator::released`] hashes.
    pub fn note(&mut self, v: &Validator) {
        self.pending.extend_from_slice(v.released());
    }

    /// Drop from `store` every queued hash that is in neither names(S_n) nor C nor `displayed()`
    /// (the hashes the display draws from; called only when something is queued). Returns the
    /// number of store entries dropped.
    pub fn sweep(
        &mut self,
        v: &Validator,
        store: &mut PayloadStore,
        displayed: impl FnOnce() -> HashSet<Hash>,
    ) -> u32 {
        self.sweep_with(v, displayed, |h| store.release(h))
    }

    /// [`Self::sweep`] over any store: `release(h)` drops `h` from it and says whether it held
    /// it (W11d: the native receiver's store is `RsResourceCache`, so `rs-core-capi` hands the
    /// dropped hashes back to it).
    pub fn sweep_with(
        &mut self,
        v: &Validator,
        displayed: impl FnOnce() -> HashSet<Hash>,
        mut release: impl FnMut(&Hash) -> bool,
    ) -> u32 {
        if self.pending.is_empty() {
            return 0;
        }
        let shown = displayed();
        let mut dropped = 0u32;
        self.pending.retain(|h| {
            if v.names_contains(h) || v.is_carried(h) {
                // It returned (re-named, or re-carried): it is in H again.
                return false;
            }
            if shown.contains(h) {
                return true;
            }
            if release(h) {
                dropped += 1;
            }
            false
        });
        self.pending.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        self.pending.dedup();
        self.released_total += u64::from(dropped);
        dropped
    }
}
