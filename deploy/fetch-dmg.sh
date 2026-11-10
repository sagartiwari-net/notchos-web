#!/usr/bin/env bash
set -euo pipefail
# Put the staging DMG on the site. Prefer the public release URL; fall back to API + GH_TOKEN.
#   bash deploy/fetch-dmg.sh
#   GH_TOKEN=ghp_xxx bash deploy/fetch-dmg.sh   # if the release URL is private

VERSION=0.7.3
TAG=v${VERSION}-staging
NAME=NotchOS-${VERSION}.dmg
OUT=/www/wwwroot/notch.sagartiwari.net/public/downloads/${NAME}
LEGACY=/www/wwwroot/notch.sagartiwari.net/public/downloads/NotchOS-0.7.0.dmg
PREV=/www/wwwroot/notch.sagartiwari.net/public/downloads/NotchOS-0.7.2.dmg
REPO=sagartiwari-net/notchos-web
PUBLIC_URL="https://github.com/${REPO}/releases/download/${TAG}/${NAME}"

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
# Keep old email / bookmark links working.
cp -f "$OUT" "$LEGACY"
cp -f "$OUT" "$PREV"
chown www:www "$LEGACY" "$PREV"
chmod 644 "$LEGACY" "$PREV"
ls -lh "$(dirname "$OUT")"
curl -sSIL "https://notch.sagartiwari.net/downloads/${NAME}" | head -15
