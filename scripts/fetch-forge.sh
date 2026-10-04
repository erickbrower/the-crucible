#!/usr/bin/env bash
# Downloads only the card data we need from the Forge project (GPL-3.0) into vendor/forge.
# Card scripts are read at runtime; they are not committed to this repo.
set -euo pipefail
DEST="${1:-vendor/forge}"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only
else
  git clone --depth 1 --filter=blob:none --sparse https://github.com/Card-Forge/forge.git "$DEST"
  git -C "$DEST" sparse-checkout set forge-gui/res/cardsfolder forge-gui/res/tokenscripts forge-gui/res/editions forge-gui/res/formats
fi
rm -f .cache/card-index.json
echo "Forge card data ready in $DEST/forge-gui/res"
