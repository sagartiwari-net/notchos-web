#!/usr/bin/env bash
set -euo pipefail
# Put the staging DMG on the site. Prefer the public release URL; fall back to API + GH_TOKEN.
#   bash deploy/fetch-dmg.sh
#   GH_TOKEN=ghp_xxx bash deploy/fetch-dmg.sh   # if the release URL is private

OUT=/www/wwwroot/notch.sagartiwari.net/public/downloads/NotchOS-0.7.0.dmg
TAG=v0.7.0-staging
REPO=sagartiwari-net/notchos-web
PUBLIC_URL="https://github.com/${REPO}/releases/download/${TAG}/NotchOS-0.7.0.dmg"

mkdir -p "$(dirname "$OUT")"

if curl -fL --progress-bar -o "$OUT" "$PUBLIC_URL"; then
  echo "Downloaded via public release URL → $OUT"
elif [[ -n "${GH_TOKEN:-}" ]]; then
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
else
  echo "Public download failed. Set GH_TOKEN (Mac: gh auth token) and retry." >&2
  exit 1
fi

chown www:www "$OUT"
chmod 644 "$OUT"
ls -lh "$OUT"
curl -sSIL "https://notch.sagartiwari.net/downloads/NotchOS-0.7.0.dmg" | head -15
