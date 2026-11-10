#!/usr/bin/env bash
# Run on the VPS after clone/reset:
#   cd /www/wwwroot/notch.sagartiwari.net && bash deploy/finish-server.sh
# Avoids pasting huge heredocs into aaPanel's web terminal (it corrupts them).
set -euo pipefail

SITE=/www/wwwroot/notch.sagartiwari.net
INC_DIR=/www/server/panel/vhost/nginx/extension/notch.sagartiwari.net
CONF=/www/server/panel/vhost/nginx/notch.sagartiwari.net.conf
EMAIL="${1:-sagartiwari282@gmail.com}"

export PATH="/www/server/nodejs/v22.23.4/bin:/www/server/nodejs/v22.21.1/bin:$PATH"

if [[ ! -d "$SITE/.git" ]]; then
  echo "error: run from a cloned site at $SITE" >&2
  exit 1
fi

mkdir -p "$INC_DIR" "$SITE/public/downloads"
chown -R www:www "$SITE/public" "$SITE/api" /www/server/notchos || true

# Proxy / admin / downloads snippet (written with printf — no fragile paste heredoc)
SNIP="$INC_DIR/notchos.conf"
{
  echo 'location = /admin { return 301 /admin/; }'
  echo 'location /admin/ {'
  echo '    try_files $uri $uri/ /admin/index.html;'
  echo '}'
  echo 'location /downloads/ {'
  echo '    add_header Content-Disposition "attachment";'
  echo '    add_header Cache-Control "public, max-age=300";'
  echo '    types { application/octet-stream dmg; }'
  echo '    default_type application/octet-stream;'
  echo '    try_files $uri =404;'
  echo '}'
  echo 'location /v1/ {'
  echo '    proxy_http_version 1.1;'
  echo '    proxy_set_header Host $host;'
  echo '    proxy_set_header X-Real-IP $remote_addr;'
  echo '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  echo '    proxy_set_header X-Forwarded-Proto $scheme;'
  echo '    proxy_pass http://127.0.0.1:4391;'
  echo '}'
  echo 'location /api/ {'
  echo '    proxy_http_version 1.1;'
  echo '    proxy_set_header Host $host;'
  echo '    proxy_set_header X-Real-IP $remote_addr;'
  echo '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  echo '    proxy_set_header X-Forwarded-Proto $scheme;'
  echo '    proxy_pass http://127.0.0.1:4391;'
  echo '}'
} > "$SNIP"

if [[ ! -f "$CONF" ]]; then
  echo "error: missing $CONF" >&2
  ls /www/server/panel/vhost/nginx/ | head -50 >&2 || true
  exit 1
fi

# root → public (idempotent)
sed -i 's|root */www/wwwroot/notch.sagartiwari.net;|root /www/wwwroot/notch.sagartiwari.net/public;|g' "$CONF"

# Deduplicate botched includes from earlier pastes, then add one clean include
sed -i '/extension\/notch\.sagartiwari\.net\/\*\.conf/d' "$CONF"
sed -i '/root /a\    include /www/server/panel/vhost/nginx/extension/notch.sagartiwari.net/*.conf;' "$CONF"

echo '=== nginx conf (root/include) ==='
grep -n 'root \|include.*extension/notch\|server_name' "$CONF" | head -20

# Find aaPanel / openresty / nginx binary
NGINX_BIN=""
for c in \
  /www/server/nginx/sbin/nginx \
  /www/server/openresty/nginx/sbin/nginx \
  /usr/local/nginx/sbin/nginx \
  "$(command -v nginx 2>/dev/null || true)"
do
  if [[ -n "$c" && -x "$c" ]]; then NGINX_BIN=$c; break; fi
done
if [[ -z "$NGINX_BIN" ]]; then
  NGINX_BIN="$(find /www/server -type f -name nginx 2>/dev/null | head -1 || true)"
fi
if [[ -z "$NGINX_BIN" || ! -x "$NGINX_BIN" ]]; then
  echo "error: nginx binary not found under /www/server" >&2
  find /www/server -name nginx 2>/dev/null | head -20 >&2 || true
  exit 1
fi
echo "Using nginx: $NGINX_BIN"

"$NGINX_BIN" -t
"$NGINX_BIN" -s reload

systemctl restart notchos-api || true
sleep 1

echo '=== health local ==='
curl -sS http://127.0.0.1:4391/v1/health; echo
echo '=== health public ==='
curl -sS https://notch.sagartiwari.net/v1/health; echo
echo '=== site headers ==='
curl -sSIL https://notch.sagartiwari.net/ | head -15

echo '=== create license ==='
cd "$SITE/api"
export NOTCHOS_ENV_FILE=/www/server/notchos/api.env
npm run license:create -- "$EMAIL" lifetime

echo
echo "Next: upload DMG via aaPanel Files to:"
echo "  $SITE/public/downloads/NotchOS-0.7.0.dmg"
echo "Then open https://notch.sagartiwari.net/download"
