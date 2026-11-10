#!/usr/bin/env bash
set -euo pipefail
# Usage on server:
#   GH_TOKEN=ghp_xxx bash deploy/fetch-dmg.sh
# Get token on Mac:  gh auth token

OUT=/www/wwwroot/notch.sagartiwari.net/public/downloads/NotchOS-0.7.0.dmg
TAG=v0.7.0-staging
REPO=sagartiwari-net/notchos-web

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "Set GH_TOKEN first (from Mac: gh auth token)" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
ASSET_ID=$(curl -fsSL \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" \
  | python3 -c 'import sys,json; a=json.load(sys.stdin)["assets"]; print(next(x["id"] for x in a if x["name"].endswith(".dmg")))')

echo "Downloading asset id=$ASSET_ID → $OUT"
curl -fL --progress-bar \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/octet-stream" \
  -o "$OUT" \
  "https://api.github.com/repos/${REPO}/releases/assets/${ASSET_ID}"

chown www:www "$OUT"
chmod 644 "$OUT"
ls -lh "$OUT"
curl -sSIL "https://notch.sagartiwari.net/downloads/NotchOS-0.7.0.dmg" | head -15
