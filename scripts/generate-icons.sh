#!/usr/bin/env bash
# Regenerate checked-in PNGs with the same librsvg version as the Nix build.
# Run: nix develop --command bash scripts/generate-icons.sh
set -euo pipefail
cd "$(dirname "$0")/.."
for size in 16 32 48 128; do
  rsvg-convert --width "$size" --height "$size" \
    --output "extension/icons/icon-$size.png" extension/icons/linput.svg
done
