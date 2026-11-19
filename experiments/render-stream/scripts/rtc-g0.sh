#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
RTC="$ROOT/experiments/render-stream/rtc"
case "${1:-}" in
serve)
  shift
  exec node "$RTC/serve.mjs" "$@"
  ;;
probe)
  shift
  ip= port=45000 cert_dir="$ROOT/.local/rtc-g0/cert"
  while [ "$#" -gt 0 ]; do
    case "$1" in
    --ip) ip="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --cert-dir) cert_dir="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
    esac
  done
  [ -n "$ip" ] || { echo '--ip is required' >&2; exit 2; }
  # The quiet lock is Linux/procfs-only, like the native build runners' lock.
  quiet=()
  if [ "$(uname -s)" != Darwin ]; then
    quiet=("$HERE/lib/quiet.sh" shared --)
  fi
  ${quiet[@]+"${quiet[@]}"} mise exec -- cargo build --offline --locked --release \
    --manifest-path "$ROOT/experiments/render-stream/rs-net/Cargo.toml" --features rtc --bin rs-net-rtc-probe
  exec node --input-type=module - "$RTC" "$ip" "$port" "$cert_dir" <<'JS'
import { pathToFileURL } from 'node:url';
const [rtc, ip, port, cert] = process.argv.slice(2);
const { startProbe } = await import(pathToFileURL(`${rtc}/probe.mjs`));
const probe = await startProbe(ip, cert, '/dev/stderr', Number(port));
const query = new URLSearchParams({h: `${probe.discovery.ip}:${probe.discovery.port}`, f: probe.discovery.fp});
console.log(JSON.stringify(probe.discovery));
console.log(`Page query (use with the page on any secure origin): ?${query}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await probe.stop(); process.exit(); });
probe.child.on('exit', code => process.exit(code ?? 1));
JS
  ;;
*) echo 'rtc-g0.sh probe --ip IP [--port P] [--cert-dir D] | serve [--port P]' >&2; exit 2 ;;
esac
