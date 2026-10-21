//! [`IdTable`] (G7o4): the resolved state's ordered map from wire id to entry.
//!
//! The resolved state keys every table by wire id and iterates it in ascending id order (the
//! order the resolved form lists entries in), which a `BTreeMap` gives. But the applier and the
//! validator look entries up by id thousands of times per transaction, and on the g31's in-order
//! A55 cores a B-tree search (a branchy key scan per node, a cache miss per level) costs several
//! times an array index. Wire ids are small and dense in practice (a capture numbers them from 1),
//! so ids below [`DENSE_LIMIT`] index a slot array (4 bytes per id) that names the entry's place in
//! a value arena, and only larger ids fall back to a `BTreeMap`. Iteration walks the slots in id
//! order, then the fallback (every fallback id is above every slot id), so it is ascending id order
//! exactly as before: the table is a drop-in for the `BTreeMap` it replaces.

use crate::state::Id;
use std::collections::BTreeMap;

/// Ids below this index the slot array; the rest live in the fallback `BTreeMap`. At most 256 KiB
/// of slots however sparse the ids below it are.
pub const DENSE_LIMIT: Id = 1 << 16;

#[derive(Clone)]
pub struct IdTable<V> {
    /// `slots[id]` is `1 +` the entry's index in `vals`, or 0 when `id` has no entry.
    slots: Vec<u32>,
    /// The dense entries, in insertion order (a removal swaps the last one into its place).
    vals: Vec<(Id, V)>,
    sparse: BTreeMap<Id, V>,
}

impl<V> Default for IdTable<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V> IdTable<V> {
    pub const fn new() -> Self {
        IdTable {
            slots: Vec::new(),
            vals: Vec::new(),
            sparse: BTreeMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.vals.len() + self.sparse.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&mut self) {
        self.slots.clear();
        self.vals.clear();
        self.sparse.clear();
    }

    #[inline]
    fn slot(&self, id: Id) -> Option<usize> {
        match self.slots.get(id as usize) {
            Some(&s) if s != 0 => Some(s as usize - 1),
            _ => None,
        }
    }

    #[inline]
    pub fn get(&self, id: &Id) -> Option<&V> {
        if *id < DENSE_LIMIT {
            self.slot(*id).map(|i| &self.vals[i].1)
        } else {
            self.sparse.get(id)
        }
    }

    #[inline]
    pub fn get_mut(&mut self, id: &Id) -> Option<&mut V> {
        if *id < DENSE_LIMIT {
            self.slot(*id).map(|i| &mut self.vals[i].1)
        } else {
            self.sparse.get_mut(id)
        }
    }

    #[inline]
    pub fn contains_key(&self, id: &Id) -> bool {
        if *id < DENSE_LIMIT {
            self.slot(*id).is_some()
        } else {
            self.sparse.contains_key(id)
        }
    }

    /// As `BTreeMap::insert`: the previous value, if `id` had one.
    pub fn insert(&mut self, id: Id, value: V) -> Option<V> {
        if id >= DENSE_LIMIT {
            return self.sparse.insert(id, value);
        }
        if let Some(i) = self.slot(id) {
            return Some(std::mem::replace(&mut self.vals[i].1, value));
        }
        let k = id as usize;
        if self.slots.len() <= k {
            self.slots.resize(k + 1, 0);
        }
        self.vals.push((id, value));
        self.slots[k] = self.vals.len() as u32;
        None
    }

    pub fn remove(&mut self, id: &Id) -> Option<V> {
        if *id >= DENSE_LIMIT {
            return self.sparse.remove(id);
        }
        let i = self.slot(*id)?;
        self.slots[*id as usize] = 0;
        let (_, value) = self.vals.swap_remove(i);
        if let Some(&(moved, _)) = self.vals.get(i) {
            self.slots[moved as usize] = i as u32 + 1;
        }
        Some(value)
    }

    /// Entries in ascending id order.
    pub fn iter(&self) -> Iter<'_, V> {
        Iter {
            slots: self.slots.iter(),
            vals: &self.vals,
            sparse: self.sparse.iter(),
        }
    }

    pub fn keys(&self) -> impl Iterator<Item = &Id> + '_ {
        self.iter().map(|(k, _)| k)
    }

    pub fn values(&self) -> impl Iterator<Item = &V> + '_ {
        self.iter().map(|(_, v)| v)
    }
}

/// [`IdTable::iter`]: the slots in id order, then the fallback.
pub struct Iter<'a, V> {
    slots: std::slice::Iter<'a, u32>,
    vals: &'a [(Id, V)],
    sparse: std::collections::btree_map::Iter<'a, Id, V>,
}

impl<'a, V> Iterator for Iter<'a, V> {
    type Item = (&'a Id, &'a V);

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        for &s in self.slots.by_ref() {
            if s != 0 {
                let (id, value) = &self.vals[s as usize - 1];
                return Some((id, value));
            }
        }
        self.sparse.next()
    }
}

impl<'a, V> IntoIterator for &'a IdTable<V> {
    type Item = (&'a Id, &'a V);
    type IntoIter = Iter<'a, V>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

impl<V> std::ops::Index<&Id> for IdTable<V> {
    type Output = V;

    fn index(&self, id: &Id) -> &V {
        self.get(id).expect("no entry found for key")
    }
}

impl<V: PartialEq> PartialEq for IdTable<V> {
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().zip(other.iter()).all(|(a, b)| a == b)
    }
}

impl<V: std::fmt::Debug> std::fmt::Debug for IdTable<V> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

impl<V> FromIterator<(Id, V)> for IdTable<V> {
    fn from_iter<I: IntoIterator<Item = (Id, V)>>(iter: I) -> Self {
        let mut t = IdTable::new();
        for (id, v) in iter {
            t.insert(id, v);
        }
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn behaves_as_the_btreemap_it_replaces() {
        let mut t: IdTable<u64> = IdTable::new();
        let mut b: BTreeMap<Id, u64> = BTreeMap::new();
        // Deterministic mixed operations over dense and fallback ids.
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        for step in 0..20_000u64 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let id = if x % 11 == 0 {
                DENSE_LIMIT + (x >> 8) as Id % 300
            } else {
                (x >> 16) as Id % 600
            };
            match x % 5 {
                0 | 1 | 2 => assert_eq!(t.insert(id, step), b.insert(id, step)),
                3 => assert_eq!(t.remove(&id), b.remove(&id)),
                _ => {
                    assert_eq!(t.get(&id), b.get(&id));
                    assert_eq!(t.contains_key(&id), b.contains_key(&id));
                    if let (Some(a), Some(c)) = (t.get_mut(&id), b.get_mut(&id)) {
                        *a += 1;
                        *c += 1;
                    }
                }
            }
            assert_eq!(t.len(), b.len());
        }
        assert!(t.iter().eq(b.iter()));
        assert!(t.keys().eq(b.keys()));
        assert!(t.values().eq(b.values()));
        assert_eq!(format!("{t:?}"), format!("{b:?}"));
        let c: IdTable<u64> = b.iter().map(|(k, v)| (*k, *v)).collect();
        assert_eq!(c, t);
        t.clear();
        assert!(t.is_empty() && t.iter().next().is_none());
    }
}
