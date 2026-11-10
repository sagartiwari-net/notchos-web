#!/usr/bin/env bash
# Fix ALL Apache VirtualHosts for notch.sagartiwari.net (HTTP + HTTPS).
set -euo pipefail

CONF=/www/server/panel/vhost/apache/notch.sagartiwari.net.conf
SITE_PUBLIC=/www/wwwroot/notch.sagartiwari.net/public

if [[ ! -f "$CONF" ]]; then
  echo "missing $CONF" >&2
  exit 1
fi

cp -a "$CONF" "$CONF.bak.$(date +%s)"

# Every DocumentRoot / Directory for this site → public
sed -i 's|DocumentRoot *"/www/wwwroot/notch.sagartiwari.net/"|DocumentRoot "/www/wwwroot/notch.sagartiwari.net/public"|g' "$CONF"
sed -i 's|DocumentRoot *"/www/wwwroot/notch.sagartiwari.net"|DocumentRoot "/www/wwwroot/notch.sagartiwari.net/public"|g' "$CONF"
sed -i 's|<Directory *"/www/wwwroot/notch.sagartiwari.net/">|<Directory "/www/wwwroot/notch.sagartiwari.net/public">|g' "$CONF"
sed -i 's|<Directory *"/www/wwwroot/notch.sagartiwari.net">|<Directory "/www/wwwroot/notch.sagartiwari.net/public">|g' "$CONF"

# Strip old NotchOS blocks
sed -i '/# BEGIN NOTCHOS/,/# END NOTCHOS/d' "$CONF"

BLOCK_FILE="$(mktemp)"
cat > "$BLOCK_FILE" <<EOF
  # BEGIN NOTCHOS
  ProxyPreserveHost On
  RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}
  ProxyPass /v1/ http://127.0.0.1:4391/v1/
  ProxyPassReverse /v1/ http://127.0.0.1:4391/v1/
  ProxyPass /api/ http://127.0.0.1:4391/api/
  ProxyPassReverse /api/ http://127.0.0.1:4391/api/
  # Admin SPA calls /admin-api/* → API /admin/*
  ProxyPass /admin-api/ http://127.0.0.1:4391/admin/
  ProxyPassReverse /admin-api/ http://127.0.0.1:4391/admin/
  <Directory "${SITE_PUBLIC}">
    Options FollowSymLinks
    AllowOverride All
    Require all granted
  </Directory>
  <Directory "${SITE_PUBLIC}/admin">
    FallbackResource /admin/index.html
  </Directory>
  # END NOTCHOS
EOF

# Insert block before EVERY </VirtualHost>
TMP="$(mktemp)"
awk -v blockfile="$BLOCK_FILE" '
  BEGIN { while ((getline line < blockfile) > 0) blk = blk line "\n"; close(blockfile) }
  /<\/VirtualHost>/ { printf "%s", blk }
  { print }
' "$CONF" > "$TMP"
mv "$TMP" "$CONF"
rm -f "$BLOCK_FILE"

# Ensure public is readable
chown -R www:www /www/wwwroot/notch.sagartiwari.net/public
chmod -R a+rX /www/wwwroot/notch.sagartiwari.net/public

echo '=== DocumentRoot lines ==='
grep -n DocumentRoot "$CONF"

echo '=== NOTCHOS markers count (expect 2+) ==='
grep -c 'BEGIN NOTCHOS' "$CONF" || true

if [[ -x /etc/init.d/httpd ]]; then
  /etc/init.d/httpd reload || /etc/init.d/httpd restart
elif [[ -x /www/server/apache/bin/apachectl ]]; then
  /www/server/apache/bin/apachectl configtest
  /www/server/apache/bin/apachectl graceful
fi

sleep 1
echo '=== tests ==='
curl -sS http://127.0.0.1:4391/v1/health; echo
curl -sS https://notch.sagartiwari.net/v1/health; echo
curl -sSIL https://notch.sagartiwari.net/ | head -15
curl -sSIL https://notch.sagartiwari.net/download | head -12
ls -la /www/wwwroot/notch.sagartiwari.net/public/index.html
