#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
PORT="${1:-8080}"
URL="http://127.0.0.1:$PORT/"

if command -v python3 >/dev/null 2>&1; then
  echo "PixelGBA: $URL"
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
elif command -v node >/dev/null 2>&1; then
  exec node serve.js "$PORT" 127.0.0.1
elif command -v python >/dev/null 2>&1; then
  echo "PixelGBA: $URL"
  exec python -m http.server "$PORT" --bind 127.0.0.1
else
  echo "PixelGBA needs Python 3 or Node.js to run locally." >&2
  exit 1
fi
