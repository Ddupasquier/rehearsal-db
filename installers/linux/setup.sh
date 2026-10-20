#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 24 or 26 manually, then run this helper again. Nothing was installed."
  exit 1
fi
exec node "$HERE/../shared/setup.mjs" --platform=linux "$@"
