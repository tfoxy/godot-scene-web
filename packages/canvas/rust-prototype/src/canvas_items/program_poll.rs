use std::ops::ControlFlow;

/// A status read can block on driver compilation. Check elapsed time between settles, while
/// always allowing the first ready link to make progress even if it overruns the budget.
const SETTLE_BUDGET_MS: f64 = 8.0;

/// Shared by item and depth links. The extension supersedes the fence; the epoch fallback
/// applies only if fence creation failed. Keep the fence read lazy on the extension path.
pub(super) fn link_ready(
    completion: Option<bool>,
    fence: impl FnOnce() -> Option<bool>,
    fallback: bool,
) -> bool {
    completion.unwrap_or_else(|| fence().unwrap_or(fallback))
}

/// Polling a lost context must neither consume restore reports nor query dead fences.
/// Restored links were already recompiled; deliver each report once before new link work.
/// `elapsed_ms` includes readiness checks and the actual status reads in `settle`, which returns
/// `None` for an unsignalled link and breaks if the context is lost during a settle.
pub(super) fn poll_links<T>(
    context_ready: bool,
    restored: &mut Vec<(u32, T)>,
    ids: impl Iterator<Item = u32>,
    mut elapsed_ms: impl FnMut() -> f64,
    mut settle: impl FnMut(u32) -> ControlFlow<(), Option<T>>,
) -> Vec<(u32, T)> {
    if !context_ready {
        return Vec::new();
    }
    restored.sort_unstable_by_key(|(id, _)| *id);
    let mut done = std::mem::take(restored);
    let mut ids: Vec<_> = ids.collect();
    ids.sort_unstable();
    let mut settled = false;
    for id in ids {
        if settled && elapsed_ms() >= SETTLE_BUDGET_MS {
            break;
        }
        match settle(id) {
            ControlFlow::Continue(Some(result)) => {
                done.push((id, result));
                settled = true;
            }
            ControlFlow::Continue(None) => {}
            ControlFlow::Break(()) => break,
        }
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_and_depth_links_wait_for_their_fence_even_after_the_epoch() {
        for fallback in [false, true] {
            assert!(!link_ready(None, || Some(false), fallback));
            assert!(link_ready(None, || Some(true), fallback));
        }
        assert!(!link_ready(None, || None, false));
        assert!(link_ready(None, || None, true));
    }

    #[test]
    fn parallel_completion_does_not_read_the_fence() {
        for completed in [false, true] {
            assert_eq!(link_ready(Some(completed), || panic!("fence read"), true), completed);
        }
    }

    fn settle_ids(
        ids: impl Iterator<Item = u32>,
        mut ready: impl FnMut(u32) -> bool,
        elapsed: &std::cell::Cell<f64>,
        read_ms: f64,
    ) -> Vec<u32> {
        poll_links(true, &mut Vec::new(), ids, || elapsed.get(), |id| {
            if !ready(id) {
                return ControlFlow::Continue(None);
            }
            elapsed.set(elapsed.get() + read_ms);
            ControlFlow::Continue(Some(()))
        }).into_iter().map(|(id, ())| id).collect()
    }

    #[test]
    fn lost_fenced_links_are_not_queried_and_restore_reports_once() {
        let mut restored = Vec::new();
        let lost = poll_links(false, &mut restored, [1, 2].into_iter(),
            || panic!("lost clock"), |_| panic!("dead fence"));
        assert_eq!(lost, Vec::<(u32, bool)>::new());
        // The restore recompiled the pending links, including a failed program.
        restored.extend([(4, true), (2, false), (3, true), (1, true)]);
        assert_eq!(poll_links(true, &mut restored, std::iter::empty(), || 0.0,
            |_| panic!("already restored")), [(1, true), (2, false), (3, true), (4, true)]);
        assert!(poll_links(true, &mut restored, std::iter::empty(), || 0.0,
            |_| panic!("already reported")).is_empty());
    }

    #[test]
    fn reads_stop_when_the_time_budget_is_spent() {
        for (read_ms, expected) in [(4.0, 2), (5.0, 2), (1.0, 8)] {
            let elapsed = std::cell::Cell::new(0.0);
            let done = settle_ids((1..=10).rev(), |_| true, &elapsed, read_ms);
            assert_eq!(done, (1..=expected).collect::<Vec<_>>(), "read_ms={read_ms}");
            assert!(elapsed.get() >= SETTLE_BUDGET_MS);
        }
    }

    #[test]
    fn always_settles_one_ready_link_even_when_the_first_read_overruns() {
        let elapsed = std::cell::Cell::new(0.0);
        assert_eq!(settle_ids(1..=3, |_| true, &elapsed, 50.0), [1]);
        // Time spent before finding the first signalled link cannot prevent progress either.
        elapsed.set(SETTLE_BUDGET_MS);
        assert_eq!(settle_ids(1..=3, |id| id != 1, &elapsed, 5.0), [2]);
    }

    #[test]
    fn unsignalled_low_ids_do_not_starve_ready_links_over_multiple_polls() {
        let elapsed = std::cell::Cell::new(0.0);
        let mut pending = vec![7, 5, 3, 1, 6, 4, 2];
        for expected in [[1, 3], [4, 5], [6, 7]] {
            elapsed.set(0.0);
            let done = settle_ids(pending.iter().copied(), |id| id != 2, &elapsed, 4.0);
            assert_eq!(done, expected);
            pending.retain(|id| !done.contains(id));
        }
        elapsed.set(0.0);
        assert!(settle_ids(pending.iter().copied(), |_| false, &elapsed, 4.0).is_empty());
        assert_eq!(settle_ids(pending.into_iter(), |_| true, &elapsed, 4.0), [2]);
    }

    #[test]
    fn loss_during_a_status_read_stops_before_querying_the_next_link() {
        let done = poll_links(true, &mut Vec::new(), 1..=3, || 0.0, |id| match id {
            1 => ControlFlow::Continue(Some(())),
            2 => ControlFlow::Break(()),
            _ => panic!("dead fence"),
        });
        assert_eq!(done, [(1, ())]);
    }
}
