#!/usr/bin/env python3
"""Serve build-android-shell.sh's client-pack directory (loopback by default)."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re


class PackHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if not re.fullmatch(r"/client-pack/(manifest\.json|[0-9a-f]{64}\.pck)", self.path):
            self.send_error(404)
            return
        if self.server.bad_sha:
            manifest_path = Path(self.directory) / "client-pack/manifest.json"
            manifest = json.loads(manifest_path.read_text())
            if self.path == "/client-pack/manifest.json":
                manifest["sha256"] = "0" * 64
                body = json.dumps(manifest).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == "/client-pack/" + "0" * 64 + ".pck":
                # Deliver real bytes under the false hash, to exercise verification (not a 404).
                self.path = "/client-pack/" + manifest["sha256"] + ".pck"
        super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parent.parent / "android-shell/build")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bad-sha", action="store_true", help="test-only: serve an incorrect manifest hash")
    args = parser.parse_args()
    if not (args.directory / "client-pack/manifest.json").is_file():
        parser.error("build output has no client-pack/manifest.json")
    server = ThreadingHTTPServer((args.host, args.port), partial(PackHandler, directory=str(args.directory)))
    server.bad_sha = args.bad_sha
    print(f"pack server: http://{args.host}:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
