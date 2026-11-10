#!/usr/bin/env bash
# Pull live-admin code, rebuild, fix Apache /admin-api, restart API.
# Then create an admin user if none exists (pass user+pass as args).
#
#   bash deploy/go-live-admin.sh
#   bash deploy/go-live-admin.sh myuser 'MySecurePass12'
set -euo pipefail

SITE=/www/wwwroot/notch.sagartiwari.net
export PATH="/www/server/nodejs/v22.23.4/bin:$PATH"
export NOTCHOS_ENV_FILE=/www/server/notchos/api.env
export NOTCHOS_MIGRATE_ENV_FILE=/www/server/notchos/migrate.env

cd "$SITE"
git pull origin main
bash deploy/fix-apache-vhosts.sh
bash deploy/reset-server.sh

ADMIN_USER="${1:-}"
ADMIN_PASS="${2:-}"

if [[ -n "$ADMIN_USER" && -n "$ADMIN_PASS" ]]; then
  echo "==> admin:create $ADMIN_USER"
  cd "$SITE/api"
  npm run admin:create -- "$ADMIN_USER" "$ADMIN_PASS"
else
  echo ""
  echo "No admin user args given. Create one with:"
  echo "  cd $SITE/api && NOTCHOS_ENV_FILE=$NOTCHOS_ENV_FILE npm run admin:create -- YOUR_USER 'YourPassword12+'"
fi

echo ""
echo "Open https://notch.sagartiwari.net/admin/"
echo "Login needs username + password + 6-digit authenticator code from the otpauth URL printed by admin:create."
