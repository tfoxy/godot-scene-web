#!/usr/bin/env python3
"""Fetch digest-pinned Chrome for Testing for Windows; optionally run its DOM probe."""
import argparse
import base64
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile


VERSION = "148.0.7778.96"
URL = f"https://storage.googleapis.com/chrome-for-testing-public/{VERSION}/win64/chrome-win64.zip"
EXPECTED_ZIP_SHA256 = "6cd8c5f6eeff7b6515dbcd35d050f696da3f7eac4b4a209c06e3d4354c2704a6"
EXPECTED_EXE_SHA256 = "290fa7018fda22c52ada5eddb0113baf3ebc41fd0fde6085eddb19793606c635"
EXE = "chrome-win64/chrome.exe"
# Retain D9's --enable-gpu; the hosted runner uses software ANGLE instead of Vulkan.
WINDOWS_LAUNCH_ARGS = ["--headless=new", "--enable-gpu",
                       "--force-device-scale-factor=1", "--force-color-profile=srgb",
                       "--no-first-run", "--no-default-browser-check", "--disable-gpu-sandbox",
                       "--use-angle=swiftshader", "--enable-logging=stderr", "--v=1"]


def fetch(out):
    out.mkdir(parents=True, exist_ok=True)
    facts = {"url": URL, "zip_bytes": 0, "zip_sha256": "unavailable",
             "exe_sha256": "unavailable", "expected_zip_sha256": EXPECTED_ZIP_SHA256,
             "expected_exe_sha256": EXPECTED_EXE_SHA256}
    try:
        with tempfile.TemporaryDirectory(prefix=".cft-", dir=out) as stage:
            archive_path = Path(stage) / "chrome-win64.zip"
            with urllib.request.urlopen(URL, timeout=60) as response, archive_path.open("wb") as dest:
                shutil.copyfileobj(response, dest)
            facts["zip_bytes"] = archive_path.stat().st_size
            with archive_path.open("rb") as stream:
                facts["zip_sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
            with zipfile.ZipFile(archive_path) as archive:
                with archive.open(EXE) as stream:
                    facts["exe_sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
                for kind in ("zip", "exe"):
                    if facts[f"{kind}_sha256"] != facts[f"expected_{kind}_sha256"]:
                        raise ValueError(f"{kind}_sha256 mismatch")
                archive.extractall(out)
        facts["product_version"] = executable_version(out / EXE)
        if facts["product_version"] != VERSION:
            raise ValueError(f"wrong executable version: {facts['product_version']} (expected {VERSION})")
        return out / EXE
    finally:
        # On failures keep the URL and both expected/observed digests in the runner log.
        print("cft: " + json.dumps(facts, sort_keys=True), flush=True)


def executable_version(exe):
    """Read the PE's VS_FIXEDFILEINFO product version without executing Windows code."""
    data = exe.read_bytes()
    try:
        def u16(offset):
            return struct.unpack_from("<H", data, offset)[0]

        def u32(offset):
            return struct.unpack_from("<I", data, offset)[0]

        if data[:2] != b"MZ":
            raise ValueError("missing DOS signature")
        pe = u32(0x3c)
        if data[pe:pe + 4] != b"PE\0\0":
            raise ValueError("missing PE signature")
        optional = pe + 24
        directories = {0x10b: 96, 0x20b: 112}.get(u16(optional))
        if directories is None:
            raise ValueError("unknown PE optional header")
        sections = optional + u16(pe + 20)

        def file_offset(rva):
            for i in range(u16(pe + 6)):
                section = sections + i * 40
                start, size, raw = u32(section + 12), u32(section + 16), u32(section + 20)
                if start <= rva < start + size:
                    return raw + rva - start
            raise ValueError("resource RVA outside sections")

        resources = file_offset(u32(optional + directories + 16))

        def entries(relative):
            directory = resources + relative
            return [(u32(directory + 16 + i * 8), u32(directory + 20 + i * 8))
                    for i in range(u16(directory + 12) + u16(directory + 14))]

        version = next(child for name, child in entries(0) if name == 16)  # RT_VERSION
        for _ in range(2):  # version name, then language
            if not version & 0x80000000:
                raise ValueError("missing version resource directory")
            version = entries(version & 0x7fffffff)[0][1]
        if version & 0x80000000:
            raise ValueError("missing version resource data")
        resource = resources + version
        start = file_offset(u32(resource))
        end = start + u32(resource + 4)
        key = "VS_VERSION_INFO\0".encode("utf-16le")
        fixed = (6 + len(key) + 3) & ~3
        if (end > len(data) or u16(start) > end - start or u16(start + 2) != 52
                or data[start + 6:start + 6 + len(key)] != key or start + fixed + 52 > end
                or u32(start + fixed) != 0xfeef04bd):
            raise ValueError("invalid VS_FIXEDFILEINFO")
        ms, ls = u32(start + fixed + 16), u32(start + fixed + 20)
        return f"{ms >> 16}.{ms & 0xffff}.{ls >> 16}.{ls & 0xffff}"
    except (struct.error, StopIteration, IndexError, ValueError) as exc:
        raise ValueError(f"invalid executable version resource: {exc}") from exc


class ProbeDOM(HTMLParser):
    def __init__(self):
        super().__init__()
        self.inside = False
        self.count = 0
        self.text = []

    def handle_starttag(self, tag, attrs):
        if tag == "pre" and dict(attrs).get("id") == "probe":
            self.inside = True
            self.count += 1

    def handle_endtag(self, tag):
        if tag == "pre":
            self.inside = False

    def handle_data(self, data):
        if self.inside:
            self.text.append(data)


def judge_probe(dom, full_version):
    parser = ProbeDOM()
    parser.feed(dom)
    if parser.count != 1 or not "".join(parser.text).strip():
        raise ValueError("missing or empty <pre id=probe>")
    facts = json.loads("".join(parser.text))
    print("wlive-probe: " + json.dumps(facts, sort_keys=True), flush=True)
    if not isinstance(facts, dict):
        raise ValueError("probe facts must be an object")
    agent = facts.get("userAgent", "")
    if not isinstance(agent, str) or not re.search(r"\b(?:Headless)?Chrome/" + VERSION.split(".")[0] + r"\.\d+\.\d+\.\d+(?:\s|$)", agent):
        raise ValueError("wrong user-agent major version")
    if full_version != VERSION:
        raise ValueError(f"wrong executable version: {full_version} (expected {VERSION})")
    if facts.get("webTransport") != "function":
        raise ValueError('typeof WebTransport != "function"')
    if facts.get("canvasPixel") != [17, 34, 51, 255]:
        raise ValueError("failed canvas readback")
    return facts


class CDP:
    """Small synchronous, loopback-only CDP WebSocket client (no Node in windows-win)."""
    def __init__(self, url, deadline):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "ws" or parsed.hostname not in ("127.0.0.1", "localhost"):
            raise ValueError(f"non-loopback DevTools endpoint: {url}")
        self.deadline = deadline
        self.sequence = 0
        self.sock = socket.create_connection((parsed.hostname, parsed.port), self.remaining())
        try:
            key = base64.b64encode(os.urandom(16)).decode("ascii")
            request = (f"GET {parsed.path} HTTP/1.1\r\nHost: {parsed.netloc}\r\n"
                       f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                       "Sec-WebSocket-Version: 13\r\n\r\n")
            self.sock.sendall(request.encode("ascii"))
            header = bytearray()
            while not header.endswith(b"\r\n\r\n"):
                header.extend(self.read(1))
                if len(header) > 16384:
                    raise ValueError("oversized DevTools handshake")
            lines = header.decode("ascii").split("\r\n")
            headers = {name.lower(): value.strip() for line in lines[1:] if ":" in line
                       for name, value in [line.split(":", 1)]}
            accept = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()).decode("ascii")
            if lines[0].split()[1] != "101" or headers.get("sec-websocket-accept", "").strip() != accept:
                raise ValueError(f"DevTools handshake rejected: {lines[0]}")
        except BaseException:
            self.close()
            raise

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("CDP step timed out")
        return remaining

    def read(self, count):
        data = bytearray()
        while len(data) < count:
            self.sock.settimeout(self.remaining())
            part = self.sock.recv(count - len(data))
            if not part:
                raise ValueError("DevTools socket closed")
            data.extend(part)
        return bytes(data)

    def send(self, opcode, payload):
        mask = os.urandom(4)
        header = bytes([0x80 | opcode])
        size = len(payload)
        if size < 126:
            header += bytes([0x80 | size])
        elif size < 65536:
            header += bytes([0x80 | 126]) + struct.pack("!H", size)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", size)
        self.sock.settimeout(self.remaining())
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def message(self):
        payload = bytearray()
        while True:
            first, second = self.read(2)
            size = second & 127
            if size == 126:
                size = struct.unpack("!H", self.read(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self.read(8))[0]
            if size > 16 * 1024 * 1024 or second & 128:
                raise ValueError("invalid DevTools frame")
            part = self.read(size)
            opcode = first & 15
            if opcode == 8:
                raise ValueError("DevTools sent close")
            if opcode == 9:
                self.send(10, part)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1):
                raise ValueError(f"unexpected DevTools opcode {opcode}")
            payload.extend(part)
            if len(payload) > 16 * 1024 * 1024:
                raise ValueError("oversized DevTools message")
            if first & 128:
                return json.loads(payload)

    def call(self, method, params=None, session=None):
        self.sequence += 1
        command = {"id": self.sequence, "method": method, "params": params or {}}
        if session:
            command["sessionId"] = session
        self.send(1, json.dumps(command).encode("utf-8"))
        while True:
            result = self.message()
            if result.get("id") == self.sequence:
                if "error" in result:
                    raise ValueError(f"CDP {method}: {result['error']}")
                return result.get("result", {})

    def close(self):
        self.sock.close()


def process_snapshot(proc, evidence):
    # tasklist /v includes window titles (including crash dialogs) for all Chrome children.
    argv = (["tasklist", "/v"] if os.name == "nt"
            else ["ps", "-eo", "pid,ppid,stat,args"])
    with (evidence / "process-tree.log").open("wb") as dest:
        dest.write(f"Chrome root PID: {proc.pid}\n".encode())
        dest.flush()
        try:
            subprocess.run(argv, stdout=dest, stderr=subprocess.STDOUT, timeout=10, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            dest.write(str(exc).encode())


def stop_chrome(proc, evidence):
    if os.name == "nt":
        # Always target the whole tree, including when the root has already crashed.
        with (evidence / "taskkill.log").open("wb") as dest:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           stdout=dest, stderr=subprocess.STDOUT, timeout=10, check=False)
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    proc.wait(timeout=5)


def probe_variant(exe, page, out, variant, args, full_version):
    evidence = out / variant
    evidence.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    # A whole attempt is bounded as well as every CDP step; leave room in w-run's 300 s timeout.
    attempt_deadline = started + 90
    facts = {"variant": variant, "first_output_s": None, "wall_s": None, "ok": False}
    stop_monitor = threading.Event()
    proc = None
    cdp = None
    env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
    with tempfile.TemporaryDirectory(prefix=".cft-profile-", dir=out) as profile:
        argv = [str(exe), *args, f"--user-data-dir={profile}", "--remote-debugging-port=0", "about:blank"]
        (evidence / "argv.json").write_text(json.dumps(argv), encoding="utf-8")
        print("wlive-probe argv: " + json.dumps(argv), flush=True)
        stdout = evidence / "chrome-stdout.log"
        stderr = evidence / "chrome-stderr.log"

        def monitor():
            while True:
                if any(p.exists() and p.stat().st_size for p in (stdout, stderr)):
                    facts["first_output_s"] = round(time.monotonic() - started, 3)
                    return
                if stop_monitor.wait(0.01):
                    return

        thread = threading.Thread(target=monitor, daemon=True)
        try:
            with stdout.open("wb") as output, stderr.open("wb") as errors:
                thread.start()
                proc = subprocess.Popen(argv, env=env, stdout=output, stderr=errors,
                                        start_new_session=os.name != "nt")
                facts["pid"] = proc.pid

                def alive():
                    rc = proc.poll()
                    if rc is not None:
                        raise ValueError(f"Chrome exit {rc}")

                def deadline():
                    return min(attempt_deadline, time.monotonic() + 30)

                step = "DevToolsActivePort"
                limit = deadline()
                port_file = Path(profile) / "DevToolsActivePort"
                while True:
                    alive()
                    if time.monotonic() >= limit:
                        raise TimeoutError(f"{step} timed out after 30 s")
                    if port_file.exists():
                        lines = port_file.read_text(encoding="utf-8").splitlines()
                        if len(lines) >= 2 and lines[0].isdigit() and lines[1].startswith("/devtools/browser/"):
                            break
                    time.sleep(0.05)
                (evidence / "DevToolsActivePort").write_text("\n".join(lines), encoding="utf-8")
                step = "CDP connect"
                cdp = CDP(f"ws://127.0.0.1:{lines[0]}{lines[1]}", deadline())

                def call(method, params=None, session=None):
                    nonlocal step
                    step = method
                    alive()
                    cdp.deadline = deadline()
                    return cdp.call(method, params, session)

                version = call("Browser.getVersion")
                (evidence / "browser-version.json").write_text(json.dumps(version), encoding="utf-8")
                print("wlive-probe CDP product: " + str(version.get("product")), flush=True)
                if version.get("product") != f"Chrome/{VERSION}":
                    raise ValueError(f"wrong CDP full version: {version.get('product')}")
                target = call("Target.createTarget", {"url": "about:blank"})["targetId"]
                session = call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
                call("Page.enable", session=session)
                navigation = call("Page.navigate", {"url": page.resolve().as_uri()}, session)
                if navigation.get("errorText"):
                    raise ValueError(f"probe navigation: {navigation['errorText']}")
                step = "probe DOM marker"
                cdp.deadline = deadline()
                expression = "document.querySelector('pre#probe')?.textContent ? document.documentElement.outerHTML : ''"
                while True:
                    alive()
                    result = cdp.call("Runtime.evaluate", {"expression": expression, "returnByValue": True}, session)
                    if result.get("exceptionDetails"):
                        raise ValueError(f"probe evaluation: {result['exceptionDetails']}")
                    dom = result.get("result", {}).get("value", "")
                    if dom:
                        break
                    cdp.remaining()
                    time.sleep(0.05)
                (evidence / "probe.html").write_text(dom, encoding="utf-8")
                judge_probe(dom, full_version)
                alive()
                facts["ok"] = True
        except (OSError, ValueError, KeyError) as exc:
            facts["error"] = f"{step if proc else 'launch'}: {exc}"
            facts["timed_out"] = isinstance(exc, TimeoutError)
            if proc:
                process_snapshot(proc, evidence)
            raise
        finally:
            if cdp:
                cdp.close()
            try:
                if proc:
                    stop_chrome(proc, evidence)
            except (OSError, subprocess.TimeoutExpired) as exc:
                facts["ok"] = False
                facts["teardown_error"] = str(exc)
                raise
            finally:
                # Preserve crash/driver diagnostics before the isolated profile is removed.
                for log in Path(profile).rglob("chrome_debug.log"):
                    shutil.copyfile(log, evidence / ("profile-" + str(log.relative_to(profile)).replace(os.sep, "_")))
                stop_monitor.set()
                if thread.ident is not None:
                    thread.join(timeout=1)
                # Very short processes may exit before the monitoring thread is scheduled.
                if facts["first_output_s"] is None and any(p.exists() and p.stat().st_size for p in (stdout, stderr)):
                    facts["first_output_s"] = round(time.monotonic() - started, 3)
                facts["wall_s"] = round(time.monotonic() - started, 3)
                (evidence / "launch.json").write_text(json.dumps(facts, indent=2), encoding="utf-8")
                print("wlive-probe launch: " + json.dumps(facts, sort_keys=True), flush=True)


def probe(exe, page, out, full_version=None):
    (out / "probe-result.json").unlink(missing_ok=True)
    full_version = full_version or executable_version(exe)
    if full_version != VERSION:
        raise ValueError(f"wrong executable version: {full_version} (expected {VERSION})")
    print("wlive-probe executable product version: " + full_version, flush=True)
    failures = []
    variants = [("cdp-swiftshader", WINDOWS_LAUNCH_ARGS),
                ("cdp-disable-gpu", [a for a in WINDOWS_LAUNCH_ARGS if a != "--enable-gpu"] + ["--disable-gpu"])]
    for index, (variant, args) in enumerate(variants):
        if index == 1:
            print("wlive-probe skip headless=old: Chrome 148 ships unified headless; old headless requires the separate, unpinned chrome-headless-shell", flush=True)
        try:
            probe_variant(exe, page, out, variant, args, full_version)
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
            failures.append(f"{variant}: {exc}")
            print(f"wlive-probe variant failed: {failures[-1]}", flush=True)
        else:
            (out / "probe-result.json").write_text(json.dumps({"variant": variant, "ok": True}), encoding="utf-8")
            print(f"wlive-probe selected variant: {variant}", flush=True)
            return
    raise ValueError("all probe variants failed: " + "; ".join(failures))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--probe", type=Path)
    args = parser.parse_args()
    out = args.out or os.environ.get("W_RUN_ARTIFACT_DIR")
    if not out:
        parser.error("--out or W_RUN_ARTIFACT_DIR is required")
    out = Path(out).resolve()
    try:
        if args.probe:
            out.mkdir(parents=True, exist_ok=True)
            # Keep the downloaded browser out of the uploaded diagnostics, even on failure.
            with tempfile.TemporaryDirectory(prefix="wlive-cft-") as browser_dir:
                exe = fetch(Path(browser_dir))
                probe(exe, args.probe, out)
        else:
            fetch(out)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.TimeoutExpired) as exc:
        print(f"fetch-cft-windows: {URL}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
