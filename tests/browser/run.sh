#!/usr/bin/env bash
# Browser tests for practice/index.html against a local copy of the Worker.
# Needs node, python3 and playwright for python with Chromium. Run from anywhere: bash tests/browser/run.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT
PORT=8787 node "$HERE/server.mjs" & PIDS+=($!)
NOKV=1 PORT=8788 node "$HERE/server.mjs" & PIDS+=($!)
(cd "$ROOT" && exec python3 -m http.server 8080 >/dev/null 2>&1) & PIDS+=($!)
sleep 1.5
python3 "$HERE/run.py"
