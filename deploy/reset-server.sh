#!/usr/bin/env bash
# Run on the VPS after git pull, from the site root:
#   cd /www/wwwroot/notch.sagartiwari.net && ./deploy/reset-server.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f /www/server/notchos/api.env ]]; then
  echo "error: missing /www/server/notchos/api.env — copy deploy/env.production.example first" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not in PATH. Install Node 24+ in aaPanel (Node version manager)." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "error: need Node >= 22 (got $($NODE_BIN -v))" >&2
  exit 1
fi

echo "==> api: npm ci + build"
(
  cd api
  npm ci
  npm run build
)

echo "==> site: npm ci + build"
(
  cd site
  npm ci
  npm run build
)

echo "==> admin: npm ci + build (base /admin/, API /admin-api)"
(
  cd admin
  npm ci
  ADMIN_BASE=/admin/ VITE_ADMIN_API_BASE=/admin-api npm run build
)

echo "==> publish static → public/"
mkdir -p public/downloads public/admin
# Do NOT --delete the whole public/ tree: that wipes admin/ + downloads/.
rsync -a \
  --exclude 'admin' \
  --exclude 'downloads' \
  --delete \
  site/dist/ public/
rsync -a --delete admin/dist/ public/admin/
mkdir -p public/downloads
chown -R www:www public || true

echo "==> migrate database"
(
  cd api
  export NOTCHOS_ENV_FILE=/www/server/notchos/api.env
  export NOTCHOS_MIGRATE_ENV_FILE=/www/server/notchos/migrate.env
  npm run db:migrate
)

echo "==> install / restart API (systemd)"
NODE_ABS="$(command -v node)"
UNIT=/etc/systemd/system/notchos-api.service
cat >"$UNIT" <<EOF
[Unit]
Description=NotchOS license API (notch.sagartiwari.net)
After=network.target mariadb.service mysqld.service
Wants=network.target

[Service]
Type=simple
User=www
Group=www
WorkingDirectory=$ROOT/api
Environment=NOTCHOS_ENV_FILE=/www/server/notchos/api.env
ExecStart=$NODE_ABS dist/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
# Drop any hand-started process still bound to 4391 so systemd can take the port.
if command -v fuser >/dev/null 2>&1; then
  fuser -k 4391/tcp 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -t -iTCP:4391 -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$PIDS" ]]; then
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
    sleep 1
  fi
fi
systemctl daemon-reload
systemctl enable notchos-api >/dev/null
systemctl restart notchos-api
sleep 1
systemctl --no-pager --full status notchos-api | head -20
curl -sS http://127.0.0.1:4391/v1/health || true
echo

echo ""
echo "OK. Smoke:"
echo "  curl -sS https://notch.sagartiwari.net/v1/health"
echo "  ls -la public/downloads/"
echo "Admin UI (live DB): https://notch.sagartiwari.net/admin/"
echo "Create admin user (once):"
echo "  cd api && NOTCHOS_ENV_FILE=/www/server/notchos/api.env npm run admin:create -- YOUR_USER 'YourPassword12'"
echo "Create a real license:"
echo "  cd api && NOTCHOS_ENV_FILE=/www/server/notchos/api.env npm run license:create -- you@email.com lifetime"
