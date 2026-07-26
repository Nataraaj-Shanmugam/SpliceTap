#!/usr/bin/env bash
#
# Build a Chrome-Web-Store-ready ZIP of SpliceTap.
#
# Usage:
#   ./build.sh            # validate + test + lint + package
#   ./build.sh --fast     # package only (skips the gates)
#
# The ZIP is written to dist/splicetap-v<version>.zip, where <version> comes
# from manifest.json. Only files manifest.json actually references are included
# — see scripts/package-extension.js for how the allowlist is derived.

set -euo pipefail

cd "$(dirname "$0")"

FAST=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: ./build.sh [--fast]" >&2
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed or not on PATH" >&2
  exit 1
fi

VERSION="$(node -p "require('./manifest.json').version")"

echo "=============================================="
echo " SpliceTap build — v${VERSION}"
echo "=============================================="
echo

if [ "$FAST" -eq 0 ]; then
  # npm ci/install is intentionally not run here: the gates below need
  # devDependencies, so fail loudly rather than silently skipping them.
  if [ ! -d node_modules ]; then
    echo "error: node_modules missing. Run 'npm install' first," >&2
    echo "       or use './build.sh --fast' to package without the gates." >&2
    exit 1
  fi

  echo "[1/4] Validating manifest..."
  node scripts/validate-manifest.js
  echo

  echo "[2/4] Running tests..."
  npx --no-install jest --silent
  echo

  echo "[3/4] Linting..."
  npx --no-install eslint .
  echo

  STEP="[4/4]"
else
  echo "(--fast: skipping validate/test/lint)"
  echo
  STEP="[1/1]"
fi

echo "${STEP} Packaging..."
rm -rf dist
node scripts/package-extension.js
echo

ZIP="dist/splicetap-v${VERSION}.zip"
if [ ! -f "$ZIP" ]; then
  echo "error: expected ${ZIP} but it was not created" >&2
  exit 1
fi

SIZE="$(wc -c < "$ZIP" | tr -d ' ')"

echo "=============================================="
echo " Done: ${ZIP} (${SIZE} bytes)"
echo "=============================================="
echo
echo "Upload it at:"
echo "  https://chrome.google.com/webstore/devconsole"
