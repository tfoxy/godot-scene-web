use super::signature::DrawSig;
use std::collections::HashMap;

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
