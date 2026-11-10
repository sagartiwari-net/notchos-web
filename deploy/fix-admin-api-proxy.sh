#!/usr/bin/env bash
# Fix: admin SPA must call /admin-api → API /admin (not /api, which is trial-leads).
set -euo pipefail
export PATH="/www/server/nodejs/v22.23.4/bin:$PATH"
SITE=/www/wwwroot/notch.sagartiwari.net
CONF=/www/server/panel/vhost/apache/notch.sagartiwari.net.conf

cd "$SITE"
git pull origin main

echo '=== 1) API has /admin? ==='
curl -sS http://127.0.0.1:4391/admin/session | head -c 300; echo
curl -sS http://127.0.0.1:4391/v1/health; echo

echo '=== 2) Ensure Apache ProxyPass /admin-api/ ==='
if ! grep -q 'ProxyPass /admin-api/' "$CONF"; then
  echo 'admin-api missing — re-running fix-apache-vhosts'
  bash deploy/fix-apache-vhosts.sh
else
  echo 'admin-api already in conf'
  grep -n 'admin-api\|ProxyPass /v1\|ProxyPass /api' "$CONF" | head -20
  /etc/init.d/httpd reload || true
fi

echo '=== 3) Rebuild admin with VITE_ADMIN_API_BASE=/admin-api ==='
(
  cd admin
  npm ci
  ADMIN_BASE=/admin/ VITE_ADMIN_API_BASE=/admin-api npm run build
)
rsync -a --delete admin/dist/ public/admin/
chown -R www:www public/admin

# Prove the bundle contains admin-api
if grep -R -l 'admin-api' public/admin/assets/*.js >/dev/null 2>&1; then
  echo 'OK: built assets reference admin-api'
else
  echo 'WARN: admin-api string not found in assets — check Vite env'
fi

systemctl restart notchos-api
sleep 1

echo '=== 4) Probe paths ==='
echo -n 'local /admin/session: '; curl -sS http://127.0.0.1:4391/admin/session; echo
echo -n 'public /admin-api/session: '; curl -sS https://notch.sagartiwari.net/admin-api/session; echo
echo -n 'public /api/session (should NOT be admin): '; curl -sS https://notch.sagartiwari.net/api/session; echo

echo
echo 'Hard-refresh https://notch.sagartiwari.net/admin/ (Cmd+Shift+R)'
