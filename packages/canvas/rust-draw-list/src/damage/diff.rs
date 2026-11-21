use super::signature::DrawSig;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Recursive patience matching: trim each gap, then split it around its unique-hash LIS.
/// Every match preserves order. Duplicates can become anchors within smaller gaps; ambiguous
/// gaps without anchors remain unmatched and conservatively cost extra damage.
pub(super) fn unmatched(a: &[DrawSig], b: &[DrawSig]) -> (Vec<usize>, Vec<usize>) {
    let mut am = vec![false; a.len()];
    let mut bm = vec![false; b.len()];
    // An explicit worklist performs the recursion without a draw-count-dependent call stack.
    let mut gaps = vec![(0, a.len(), 0, b.len())];
    while let Some((mut ab, mut ae, mut bb, mut be)) = gaps.pop() {
        while ab < ae && bb < be && a[ab].hash == b[bb].hash {
            am[ab] = true;
            bm[bb] = true;
            ab += 1;
            bb += 1;
        }
        while ab < ae && bb < be && a[ae - 1].hash == b[be - 1].hash {
            ae -= 1;
            be -= 1;
            am[ae] = true;
            bm[be] = true;
        }
        if ab == ae || bb == be {
            continue;
        }
        let mut ac = HashMap::<u64, usize>::new();
        let mut bc = HashMap::<u64, (usize, usize)>::new();
        for d in &a[ab..ae] {
            *ac.entry(d.hash).or_default() += 1;
        }
        for (j, d) in b.iter().enumerate().take(be).skip(bb) {
            let e = bc.entry(d.hash).or_insert((j, 0));
            e.1 += 1;
        }
        let candidates: Vec<_> = a
            .iter()
            .enumerate()
            .take(ae)
            .skip(ab)
            .filter_map(|(i, d)| {
                let &(j, n) = bc.get(&d.hash)?;
                (n == 1 && ac[&d.hash] == 1).then_some((i, j))
            })
            .collect();
        let mut tails: Vec<usize> = Vec::new();
        let mut prev = vec![None; candidates.len()];
        for (k, &(_, j)) in candidates.iter().enumerate() {
            let p = tails.partition_point(|&t| candidates[t].1 < j);
            if p > 0 {
                prev[k] = Some(tails[p - 1]);
            }
            if p == tails.len() {
                tails.push(k);
            } else {
                tails[p] = k;
            }
        }
        let mut anchors = Vec::with_capacity(tails.len());
        let mut k = tails.last().copied();
        while let Some(at) = k {
            anchors.push(candidates[at]);
            k = prev[at];
        }
        // No unique common hash: leave this gap unmatched rather than guess a pairing.
        if anchors.is_empty() {
            continue;
        }
        for (i, j) in anchors.into_iter().rev() {
            am[i] = true;
            bm[j] = true;
            gaps.push((ab, i, bb, j));
            ab = i + 1;
            bb = j + 1;
        }
        gaps.push((ab, ae, bb, be));
    }
    (
        (0..a.len()).filter(|&i| !am[i]).collect(),
        (0..b.len()).filter(|&i| !bm[i]).collect(),
    )
}

// Draw signatures are already mixed u64 words. Rehashing them cryptographically adds no
// protection to this internal index; equality still compares the complete signature word.
#[derive(Default)]
struct WordHasher(u64);
impl Hasher for WordHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write_u64(&mut self, word: u64) {
        self.0 = word;
    }
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = self.0.rotate_left(8) ^ u64::from(byte);
        }
    }
}
type WordMap<V> = HashMap<u64, V, BuildHasherDefault<WordHasher>>;

/// Workspace belongs to the planner, rather than to its committed or pending snapshot.
/// Clearing lengths retains allocation across gaps and frames, including discarded plans.
#[derive(Default)]
pub(super) struct Scratch {
    am: Vec<bool>,
    bm: Vec<bool>,
    gaps: Vec<(usize, usize, usize, usize)>,
    ac: WordMap<usize>,
    bc: WordMap<(usize, usize)>,
    candidates: Vec<(usize, usize)>,
    tails: Vec<usize>,
    prev: Vec<Option<usize>>,
    anchors: Vec<(usize, usize)>,
    a: Vec<usize>,
    b: Vec<usize>,
}
impl Scratch {
    pub fn unmatched(&mut self, a: &[DrawSig], b: &[DrawSig]) -> (&[usize], &[usize]) {
        self.am.clear();
        self.am.resize(a.len(), false);
        self.bm.clear();
        self.bm.resize(b.len(), false);
        self.gaps.clear();
        self.gaps.push((0, a.len(), 0, b.len()));
        while let Some((mut ab, mut ae, mut bb, mut be)) = self.gaps.pop() {
            while ab < ae && bb < be && a[ab].hash == b[bb].hash {
                self.am[ab] = true;
                self.bm[bb] = true;
                ab += 1;
                bb += 1;
            }
            while ab < ae && bb < be && a[ae - 1].hash == b[be - 1].hash {
                ae -= 1;
                be -= 1;
                self.am[ae] = true;
                self.bm[be] = true;
            }
            if ab == ae || bb == be {
                continue;
            }
            self.ac.clear();
            self.bc.clear();
            for d in &a[ab..ae] {
                *self.ac.entry(d.hash).or_default() += 1;
            }
            for (j, d) in b.iter().enumerate().take(be).skip(bb) {
                let e = self.bc.entry(d.hash).or_insert((j, 0));
                e.1 += 1;
            }
            self.candidates.clear();
            self.candidates
                .extend(a.iter().enumerate().take(ae).skip(ab).filter_map(|(i, d)| {
                    let &(j, n) = self.bc.get(&d.hash)?;
                    (n == 1 && self.ac[&d.hash] == 1).then_some((i, j))
                }));
            self.tails.clear();
            self.prev.clear();
            self.prev.resize(self.candidates.len(), None);
            for (k, &(_, j)) in self.candidates.iter().enumerate() {
                let p = self.tails.partition_point(|&t| self.candidates[t].1 < j);
                if p > 0 {
                    self.prev[k] = Some(self.tails[p - 1]);
                }
                if p == self.tails.len() {
                    self.tails.push(k);
                } else {
                    self.tails[p] = k;
                }
            }
            self.anchors.clear();
            let mut k = self.tails.last().copied();
            while let Some(at) = k {
                self.anchors.push(self.candidates[at]);
                k = self.prev[at];
            }
            if self.anchors.is_empty() {
                continue;
            }
            for &(i, j) in self.anchors.iter().rev() {
                self.am[i] = true;
                self.bm[j] = true;
                self.gaps.push((ab, i, bb, j));
                ab = i + 1;
                bb = j + 1;
            }
            self.gaps.push((ab, ae, bb, be));
        }
        self.a.clear();
        self.a.extend((0..a.len()).filter(|&i| !self.am[i]));
        self.b.clear();
        self.b.extend((0..b.len()).filter(|&i| !self.bm[i]));
        (&self.a, &self.b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cover::PxRect;
    #[test]
    fn scratch_retains_allocations_after_empty_frame() {
        let mut scratch = Scratch::default();
        let a: Vec<_> = (0..64)
            .map(|i| DrawSig {
                hash: i * 0x123456789abcdef,
                bounds: PxRect::EMPTY,
                is_op: false,
            })
            .collect();
        let mut b = a.clone();
        b.rotate_left(1);
        scratch.unmatched(&a, &b);
        let capacities = |s: &Scratch| {
            [
                s.am.capacity(),
                s.bm.capacity(),
                s.gaps.capacity(),
                s.ac.capacity(),
                s.bc.capacity(),
                s.candidates.capacity(),
                s.tails.capacity(),
                s.prev.capacity(),
                s.anchors.capacity(),
                s.a.capacity(),
                s.b.capacity(),
            ]
        };
        let allocated = capacities(&scratch);
        assert!(allocated.iter().all(|&n| n > 0));
        scratch.unmatched(&[], &[]);
        assert_eq!(capacities(&scratch), allocated);
        let expected = unmatched(&b, &a);
        assert_eq!(
            scratch.unmatched(&b, &a),
            (expected.0.as_slice(), expected.1.as_slice())
        );
    }
    #[test]
    fn scratch_matches_reference_across_reused_gaps_and_sizes() {
        let mut scratch = Scratch::default();
        let mut seed = 42_u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for round in 0..4000 {
            let mut sigs = |len| {
                (0..len)
                    .map(|_| DrawSig {
                        hash: next() % (1 + round % 50),
                        bounds: PxRect::EMPTY,
                        is_op: false,
                    })
                    .collect::<Vec<_>>()
            };
            let a = sigs(round as usize % 97);
            let b = sigs(round as usize % 83);
            let expected = unmatched(&a, &b);
            let actual = scratch.unmatched(&a, &b);
            assert_eq!(
                actual,
                (expected.0.as_slice(), expected.1.as_slice()),
                "round {round}"
            );
        }
    }
}
