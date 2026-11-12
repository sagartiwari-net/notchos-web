#!/usr/bin/env bash
# Run on the VPS after clone/reset:
#   cd /www/wwwroot/notch.sagartiwari.net && bash deploy/finish-server.sh
# Supports aaPanel + Apache (this server) or Nginx if present.
set -euo pipefail

SITE=/www/wwwroot/notch.sagartiwari.net
EMAIL="${1:-sagartiwari282@gmail.com}"
PUBLIC="$SITE/public"

export PATH="/www/server/nodejs/v22.23.4/bin:/www/server/nodejs/v22.21.1/bin:$PATH"

if [[ ! -d "$SITE/.git" ]]; then
  echo "error: missing git checkout at $SITE" >&2
  exit 1
fi

mkdir -p "$PUBLIC/downloads" "$PUBLIC/admin"
chown -R www:www "$PUBLIC" "$SITE/api" /www/server/notchos 2>/dev/null || true

systemctl restart notchos-api || true
sleep 1
echo '=== health local ==='
curl -sS http://127.0.0.1:4391/v1/health; echo

# ---------- Apache (aaPanel) ----------
APACHE_CONF=""
for c in \
  /www/server/panel/vhost/apache/notch.sagartiwari.net.conf \
  /www/server/apache/conf/vhost/notch.sagartiwari.net.conf
do
  if [[ -f "$c" ]]; then APACHE_CONF=$c; break; fi
done

if [[ -n "$APACHE_CONF" ]]; then
  echo "Using Apache vhost: $APACHE_CONF"

  # DocumentRoot → public
  sed -i 's|DocumentRoot *"/www/wwwroot/notch.sagartiwari.net"|DocumentRoot "/www/wwwroot/notch.sagartiwari.net/public"|g' "$APACHE_CONF"
  sed -i 's|<Directory *"/www/wwwroot/notch.sagartiwari.net">|<Directory "/www/wwwroot/notch.sagartiwari.net/public">|g' "$APACHE_CONF"

  # Remove previous NotchOS marker block if re-run
  if grep -q 'BEGIN NOTCHOS' "$APACHE_CONF"; then
    sed -i '/# BEGIN NOTCHOS/,/# END NOTCHOS/d' "$APACHE_CONF"
  fi

  # Insert proxy + SPA fallback before first </VirtualHost>
  TMP="$(mktemp)"
  awk '
    /<\/VirtualHost>/ && !done {
      print "  # BEGIN NOTCHOS"
      print "  ProxyPreserveHost On"
      print "  RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}"
      print "  ProxyPass /v1/ http://127.0.0.1:4391/v1/"
      print "  ProxyPassReverse /v1/ http://127.0.0.1:4391/v1/"
      print "  ProxyPass /api/ http://127.0.0.1:4391/api/"
      print "  ProxyPassReverse /api/ http://127.0.0.1:4391/api/"
      print "  <Directory \"/www/wwwroot/notch.sagartiwari.net/public\">"
      print "    Options FollowSymLinks"
      print "    AllowOverride All"
      print "    Require all granted"
      print "    FallbackResource /index.html"
      print "  </Directory>"
      print "  <Directory \"/www/wwwroot/notch.sagartiwari.net/public/admin\">"
      print "    FallbackResource /admin/index.html"
      print "  </Directory>"
      print "  # END NOTCHOS"
      done=1
    }
    { print }
  ' "$APACHE_CONF" > "$TMP"
  mv "$TMP" "$APACHE_CONF"

  echo '=== apache snippet ==='
  grep -n 'DocumentRoot\|BEGIN NOTCHOS\|ProxyPass /v1\|END NOTCHOS' "$APACHE_CONF" | head -30

  # Enable modules if possible
  if [[ -x /www/server/apache/bin/httpd ]]; then
    /www/server/apache/bin/httpd -M 2>/dev/null | grep -E 'proxy_module|proxy_http|headers' || true
  fi

  if [[ -x /etc/init.d/httpd ]]; then
    /etc/init.d/httpd reload || /etc/init.d/httpd restart
  elif [[ -x /www/server/apache/bin/apachectl ]]; then
    /www/server/apache/bin/apachectl configtest
    /www/server/apache/bin/apachectl graceful || /www/server/apache/bin/apachectl restart
  elif command -v systemctl >/dev/null && systemctl list-units --type=service | grep -q httpd; then
    systemctl reload httpd || systemctl restart httpd
  else
    echo "warn: could not reload Apache automatically — use aaPanel → Website → Reload"
  fi
else
  echo "warn: Apache vhost for notch.sagartiwari.net not found"
  ls /www/server/panel/vhost/apache/ 2>/dev/null | head || true
fi

echo '=== health public ==='
curl -sS https://notch.sagartiwari.net/v1/health || curl -skS https://notch.sagartiwari.net/v1/health || true
echo
curl -sSIL https://notch.sagartiwari.net/ | head -15 || true

echo '=== create license ==='
cd "$SITE/api"
export NOTCHOS_ENV_FILE=/www/server/notchos/api.env
npm run license:create -- "$EMAIL" lifetime

echo
echo "Upload DMG (fixed name, always latest) to:"
echo "  $PUBLIC/downloads/NotchOS.dmg"
echo "Or: VERSION=x.y.z bash deploy/fetch-dmg.sh"
echo "Then: https://notch.sagartiwari.net/downloads/NotchOS.dmg"
