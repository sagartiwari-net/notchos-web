#!/usr/bin/env bash
set -euo pipefail
# Put the staging DMG on the site under a FIXED public name so emails/bookmarks
# always download the latest build:
#   https://notch.sagartiwari.net/downloads/NotchOS.dmg
#
# Usage (on the server):
#   bash deploy/fetch-dmg.sh
#   GH_TOKEN=ghp_xxx bash deploy/fetch-dmg.sh   # if the release URL is private
#   VERSION=0.8.33 bash deploy/fetch-dmg.sh     # override release version

VERSION="${VERSION:-0.8.34}"
TAG="v${VERSION}-staging"
NAME="NotchOS-${VERSION}.dmg"
DIR=/www/wwwroot/notch.sagartiwari.net/public/downloads
VERSIONED="${DIR}/${NAME}"
STABLE="${DIR}/NotchOS.dmg"
REPO=sagartiwari-net/notchos-web
PUBLIC_URL="https://github.com/${REPO}/releases/download/${TAG}/${NAME}"

mkdir -p "$DIR"

if curl -fL --progress-bar -o "$VERSIONED" "$PUBLIC_URL"; then
  echo "Downloaded via public release URL → $VERSIONED"
elif [[ -n "${GH_TOKEN:-}" ]]; then
  ASSET_ID=$(curl -fsSL \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" \
    | python3 -c 'import sys,json; a=json.load(sys.stdin)["assets"]; print(next(x["id"] for x in a if x["name"].endswith(".dmg")))')
  echo "Downloading asset id=$ASSET_ID → $VERSIONED"
  curl -fL --progress-bar \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/octet-stream" \
    -o "$VERSIONED" \
    "https://api.github.com/repos/${REPO}/releases/assets/${ASSET_ID}"
else
  echo "Public download failed. Set GH_TOKEN (Mac: gh auth token) and retry." >&2
  exit 1
fi

# Canonical public file — overwrite every release.
cp -f "$VERSIONED" "$STABLE"
chown www:www "$VERSIONED" "$STABLE"
chmod 644 "$VERSIONED" "$STABLE"

ls -lh "$DIR"
echo "Stable URL:"
curl -sSIL "https://notch.sagartiwari.net/downloads/NotchOS.dmg" | head -15
