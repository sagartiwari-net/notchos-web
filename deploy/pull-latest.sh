#!/usr/bin/env bash
# One-shot update on the VPS (aaPanel Terminal / SSH as root):
#   cd /www/wwwroot/notch.sagartiwari.net && bash deploy/pull-latest.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${VERSION:-0.8.35}"
STABLE_URL="https://notch.sagartiwari.net/downloads/NotchOS.dmg"
ENV_FILE=/www/server/notchos/api.env

echo "==> git pull"
git fetch origin main
git checkout main
git pull --ff-only origin main

chmod +x deploy/reset-server.sh deploy/fetch-dmg.sh deploy/pull-latest.sh

echo "==> build + migrate + restart API"
./deploy/reset-server.sh

echo "==> publish DMG as NotchOS.dmg (always latest)"
VERSION="$VERSION" bash deploy/fetch-dmg.sh

if [[ -f "$ENV_FILE" ]]; then
  if grep -q '^DOWNLOAD_URL=' "$ENV_FILE"; then
    sed -i "s|^DOWNLOAD_URL=.*|DOWNLOAD_URL=${STABLE_URL}|" "$ENV_FILE"
  else
    printf '\nDOWNLOAD_URL=%s\n' "$STABLE_URL" >>"$ENV_FILE"
  fi
  chown www:www "$ENV_FILE" 2>/dev/null || true
  echo "==> DOWNLOAD_URL → $STABLE_URL"
  systemctl restart notchos-api || true
fi

# Prefer settings table if present (admin override).
if command -v mysql >/dev/null 2>&1 && [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  if [[ -n "${DB_PASSWORD:-}" ]]; then
    mysql -h"${DB_HOST:-127.0.0.1}" -P"${DB_PORT:-3306}" -u"${DB_USER:-NotchOS}" -p"$DB_PASSWORD" "${DB_NAME:-notchos}" <<SQL || true
INSERT INTO settings (name, value) VALUES ('download_url', '${STABLE_URL}')
  ON DUPLICATE KEY UPDATE value=VALUES(value);
INSERT INTO settings (name, value) VALUES ('app_version', '${VERSION}')
  ON DUPLICATE KEY UPDATE value=VALUES(value);
SQL
    echo "==> settings.download_url + app_version updated"
  fi
fi

echo
echo "Verify:"
curl -sSIL "$STABLE_URL" | head -12
curl -sS https://notch.sagartiwari.net/v1/health || true
echo
echo "Done. Site download page should link to /downloads/NotchOS.dmg"
