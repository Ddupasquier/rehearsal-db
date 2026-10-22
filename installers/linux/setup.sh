#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_EXECUTABLE=${REHEARSAL_NODE_PATH:-node}
case "$NODE_EXECUTABLE" in
  node|/*) ;;
  *) echo "REHEARSAL_NODE_PATH must name an absolute Node executable path. Nothing was installed."; exit 1 ;;
esac
if ! command -v "$NODE_EXECUTABLE" >/dev/null 2>&1; then
  echo "Node was not found. Select Node.js 22, 24 or 26 in your version manager, or set REHEARSAL_NODE_PATH to its absolute executable path. See https://nodejs.org/en/download . Nothing was installed."
  exit 1
fi
exec "$NODE_EXECUTABLE" "$HERE/../shared/setup.mjs" --platform=linux "$@"
