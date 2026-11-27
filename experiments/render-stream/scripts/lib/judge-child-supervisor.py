#!/usr/bin/env python3
"""Supervise one checker subtree, including descendants that change process groups.

The supervisor lives outside the caller's process group. Linux parent-death notification lets it
clean up after a caller killed by a watchdog, and subreaping keeps orphaned grandchildren owned
until they are killed and reaped. Stdout/stderr remain the caller's original pipes.
"""
import ctypes
import json
import os
import shutil
import signal
import subprocess
import sys
import time


def supervise(timeout_ms, status_path, command):
    stopped_by = 0

    def stop(signum, _frame):
        nonlocal stopped_by
        stopped_by = signum

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, stop)
    parent = os.getppid()
    libc = ctypes.CDLL(None, use_errno=True)
    # PR_SET_CHILD_SUBREAPER, PR_SET_PDEATHSIG. Install before launching any child.
    for option, value in ((36, 1), (1, signal.SIGTERM)):
        if libc.prctl(option, value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl")
    if os.getsid(0) != os.getpid():
        os.setsid()
    if os.getppid() != parent or parent == 1:
        return 143
    try:
        child = subprocess.Popen(command)
    except OSError as error:
        if error.errno is None:
            raise
        # A failed exec is an ordinary spawn result, not a supervisor failure or deadline.
        with open(status_path, "w") as stream:
            json.dump({"timed_out": False, "launch_error": {"errno": -error.errno}}, stream)
        return 1
    deadline = time.monotonic() + timeout_ms / 1000
    timed_out = False
    try:
        while child.poll() is None and not stopped_by:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            time.sleep(min(0.01, remaining))
    finally:
        reap_subtree()
    rc = child.returncode
    if rc is None:
        # reap_subtree may already have waited for the immediate child.
        rc = 128 + signal.SIGKILL
    if os.getppid() != parent:
        # The caller cannot run its finally block after a watchdog kills it.
        shutil.rmtree(os.path.dirname(status_path), ignore_errors=True)
    else:
        with open(status_path, "w") as stream:
            json.dump({"timed_out": timed_out}, stream)
    if stopped_by:
        return 128 + stopped_by
    if timed_out:
        return 124
    return rc if rc >= 0 else 128 - rc


def children(pid):
    found = set()
    try:
        with os.scandir(f"/proc/{pid}/task") as tasks:
            for task in tasks:
                try:
                    with open(f"{task.path}/children") as stream:
                        found.update(int(word) for word in stream.read().split())
                except FileNotFoundError:
                    pass
    except FileNotFoundError:
        pass
    return list(found)


def send(pid, signum):
    try:
        os.kill(pid, signum)
    except ProcessLookupError:
        pass


def reap_subtree():
    while True:
        # Stop ancestors before discovering descendants: no live parent can keep forking while
        # its children are enumerated. Subreaping catches children whose parents exit meanwhile.
        pending = children(os.getpid())
        owned = set()
        while pending:
            pid = pending.pop()
            if pid in owned:
                continue
            owned.add(pid)
            send(pid, signal.SIGSTOP)
            pending.extend(children(pid))
        for pid in owned:
            send(pid, signal.SIGKILL)
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            return
        # Re-scan after reparenting, including children born immediately before SIGSTOP landed.
        time.sleep(0.001)


if __name__ == "__main__":
    sys.exit(supervise(int(sys.argv[1]), sys.argv[2], sys.argv[3:]))
