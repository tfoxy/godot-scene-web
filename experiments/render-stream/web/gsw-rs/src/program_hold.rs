//! The adapter's not-yet-defined shaders, independent of the GL context and its link handles.
//! Kept separate so its snapshot and reset rules can also be tested on the native host.

use super::{Applier, Hash, PayloadStore, ResolvedState, ShaderSource};

pub(crate) fn pending_shaders(
    held: &mut HeldPrograms<Hash, ShaderSource>,
    applier: &mut Applier,
    state: &ResolvedState,
    payloads: &PayloadStore,
) -> Vec<(u32, Hash, ShaderSource)> {
    held.prune(applier, state);
    let mut pending = applier.pending_shaders_held(state, payloads);
    held.append_to(&mut pending);
    pending
}

pub(crate) struct HeldPrograms<H, S> {
    entries: Vec<(u32, H, S)>,
}

impl<H, S> Default for HeldPrograms<H, S> {
    fn default() -> Self {
        Self { entries: Vec::new() }
    }
}

impl<H: Copy + PartialEq, S: Copy> HeldPrograms<H, S> {
    pub(crate) fn hold(&mut self, entry: (u32, H, S)) {
        if !self.entries.iter().any(|p| p.1 == entry.1) {
            self.entries.push(entry);
        }
    }

    pub(crate) fn remove(&mut self, hash: H) {
        self.entries.retain(|p| p.1 != hash);
    }

    pub(crate) fn append_to(&self, pending: &mut Vec<(u32, H, S)>) {
        pending.extend(self.entries.iter().copied());
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = &(u32, H, S)> {
        self.entries.iter()
    }

    /// Held code is still needed by a future definition, across retention and LRU sweeps.
    pub(crate) fn protect_payloads(&self, referenced: &mut std::collections::HashSet<H>)
    where H: std::hash::Hash + Eq {
        referenced.extend(self.entries.iter().map(|p| p.1));
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }
}

impl HeldPrograms<Hash, ShaderSource> {
    /// A removed or replaced material no longer needs its held code. Drop the queued
    /// definition and its omission flag so the same hash can be requested again later.
    fn prune(&mut self, applier: &mut Applier, state: &ResolvedState) {
        if self.entries.is_empty() {
            return;
        }
        let referenced: std::collections::HashSet<_> = state.materials.values()
            .filter_map(|m| m.shader.and_then(|id| state.shaders.get(&id)).and_then(|s| s.hash))
            .collect();
        self.entries.retain(|(_, hash, _)| {
            if referenced.contains(hash) {
                true
            } else {
                applier.cancel_linking(*hash);
                false
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_snapshot_keeps_held_after_new_entries_and_deduplicates_hashes() {
        let mut held = HeldPrograms::default();
        held.hold((4, 40, false));
        held.hold((5, 40, false));
        held.hold((6, 60, true));
        let mut pending = vec![(2, 20, false)];
        held.append_to(&mut pending);
        assert_eq!(pending, [(2, 20, false), (4, 40, false), (6, 60, true)]);
        // Defining or refusing a hash clears it; the current snapshot remains stable.
        held.remove(40);
        held.remove(60);
        assert_eq!(pending.len(), 3);
        assert_eq!(held.iter().count(), 0);
    }

    #[test]
    fn held_code_stays_protected_until_defined_or_refused() {
        let mut held = HeldPrograms::default();
        held.hold((1, 10, false));
        held.hold((2, 20, false));
        let mut protected = std::collections::HashSet::from([30]);
        held.protect_payloads(&mut protected);
        assert_eq!(protected, std::collections::HashSet::from([10, 20, 30]));
        held.remove(10);
        let mut protected = std::collections::HashSet::new();
        held.protect_payloads(&mut protected);
        assert_eq!(protected, std::collections::HashSet::from([20]));
        held.clear();
        let mut protected = std::collections::HashSet::new();
        held.protect_payloads(&mut protected);
        assert!(protected.is_empty());
    }

    #[test]
    fn reset_clears_all_never_begun_shaders() {
        let mut held = HeldPrograms::default();
        for i in 0..14 {
            held.hold((i, i, false));
        }
        held.clear();
        let mut pending = Vec::new();
        held.append_to(&mut pending);
        assert!(pending.is_empty());
    }
}
