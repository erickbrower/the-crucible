#!/usr/bin/env bash
# Downloads Wizards' Magic: The Gathering Comprehensive Rules (TXT) into vendor/rules.
# The rules are Wizards' document: they are read locally and not committed to this repo.
# Wizards renames the file with each update; pass the newest TXT link from https://magic.wizards.com/en/rules
#   npm run fetch-rules -- "https://media.wizards.com/2026/downloads/MagicCompRules 20260925.txt"
set -euo pipefail
URL="${1:-https://media.wizards.com/2026/downloads/MagicCompRules 20260925.txt}"
DEST="vendor/rules"
mkdir -p "$DEST"
curl -fsSL "${URL// /%20}" -o "$DEST/CompRules.txt"
# also keep Scryfall's keyword lists (names only) for cross-checking
for c in keyword-abilities keyword-actions ability-words; do
  curl -fsSL -H "User-Agent: TheCrucible/1.0" -H "Accept: application/json" "https://api.scryfall.com/catalog/$c" -o "$DEST/scryfall-$c.json" || echo "  (skipped Scryfall $c)"
done
head -c 300 "$DEST/CompRules.txt" | tr -d '\r' | grep -m1 "effective" || true
echo "Comprehensive Rules ready in $DEST/CompRules.txt"
