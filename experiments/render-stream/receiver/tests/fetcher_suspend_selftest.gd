extends SceneTree
## G7u (gate7-design.md D14 as amended): RsResourceFetcher's suspension rule, natively. On the web
## a GET's timeout counts only time while the page runs: a gap of more than SUSPEND_GAP_MS between
## two polls of a running GET moves its deadline by the gap; an idle or delaying fetcher, a short
## gap and a native fetcher (the rule off) leave the deadline alone.
##
##   mise exec -- godot --headless --path experiments/render-stream/receiver \
##     --script res://tests/fetcher_suspend_selftest.gd
##
## Prints "[fetcher-suspend-selftest] ok" and quits 0, or prints each failure and quits 1.

var _failures: int = 0


func _expect(name: String, ok: bool, detail: String = "") -> void:
	if ok:
		print("[fetcher-suspend-selftest] ok: %s" % name)
	else:
		_failures += 1
		print("[fetcher-suspend-selftest] FAIL: %s %s" % [name, detail])


func _fetcher(rule: bool, phase: String) -> RsResourceFetcher:
	var f := RsResourceFetcher.new("127.0.0.1", 1, "/resources/sha256/", 10000, 0)
	f.count_running_time_only = rule
	f._phase = phase
	f._current = {"hash": "ab"}
	f._last_poll_msec = 1000
	f._deadline_msec = 11000
	return f


func _initialize() -> void:
	_expect("native default: the rule is off", not RsResourceFetcher.new("127.0.0.1", 1, "/", 10000, 0).count_running_time_only)
	var f := _fetcher(true, "requesting")
	var gap: int = f.account_suspension(31000)
	_expect("a 30-s gap moves the deadline by it", gap == 30000 and f._deadline_msec == 41000 and f.suspended_gaps == 1 and f.suspended_ms == 30000, "gap %d deadline %d" % [gap, f._deadline_msec])
	gap = f.account_suspension(31016)
	_expect("the next frame's 16-ms gap counts as running time", gap == 0 and f._deadline_msec == 41000 and f.suspended_gaps == 1)
	f = _fetcher(true, "requesting")
	_expect("a gap at SUSPEND_GAP_MS is running time", f.account_suspension(1000 + RsResourceFetcher.SUSPEND_GAP_MS) == 0 and f._deadline_msec == 11000)
	f = _fetcher(true, "delay")
	_expect("a delaying fetcher is left alone", f.account_suspension(31000) == 0 and f._deadline_msec == 11000)
	f = _fetcher(true, "idle")
	_expect("an idle fetcher is left alone", f.account_suspension(31000) == 0 and f._deadline_msec == 11000)
	f = _fetcher(false, "requesting")
	_expect("the rule off (native): the deadline stays wall-clock", f.account_suspension(31000) == 0 and f._deadline_msec == 11000)
	if _failures == 0:
		print("[fetcher-suspend-selftest] ok")
	quit(1 if _failures > 0 else 0)
