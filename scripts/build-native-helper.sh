#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/native/chatgpt-ax-helper"

mkdir -p "$(dirname "$OUT")"
clang -framework Foundation -framework AppKit -framework ApplicationServices -fblocks -fobjc-arc \
  -o "$OUT" \
  "$ROOT/native/chatgpt-ax-helper.m"

codesign --force --sign - "$OUT" >/dev/null
echo "$OUT"
