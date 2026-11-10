# Deploy NotchOS on `notch.sagartiwari.net` (aaPanel)

Temporary public stack until a dedicated product domain exists.

| Piece | URL / port |
|---|---|
| Marketing site | `https://notch.sagartiwari.net/` |
| Download page | `https://notch.sagartiwari.net/download` |
| DMG file | `https://notch.sagartiwari.net/downloads/NotchOS-0.7.0.dmg` |
| Admin UI | `https://notch.sagartiwari.net/admin/` (**mock data until W2** — create real licenses with CLI) |
| License API | `https://notch.sagartiwari.net/v1/*` → Node on **127.0.0.1:4391** |

Port **4391** is reserved for this site so it does not collide with local-dev ports (4310–4320) or typical tool ports (4100+).

---

## 0) On your Mac first (once)

```bash
cd "/Volumes/Samsung 1TB/REA/notchos-web"

# Secrets already generated under deploy/secrets/ (gitignored). Keep them.
ls -la deploy/secrets/
# ed25519-private.pem  ed25519-public.txt  key-enc.secret

# Push this repo to GitHub (private recommended), then continue on the VPS.
```

---

## 1) aaPanel — site + database

1. **Website → Add site**
   - Domain: `notch.sagartiwari.net`
   - Path: `/www/wwwroot/notch.sagartiwari.net`
   - PHP: any / unused (we serve static + Node; no PHP app)
   - Enable **SSL** (Let’s Encrypt)
2. DNS: A record `notch` → server IP (already noted in aaPanel).
3. **Database** (you created):
   - name `notchos`
   - user `NotchOS`
   - password: the one you set in aaPanel (do **not** paste it into git)

Grant that user full rights on `notchos` (SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER/INDEX) for this temporary setup.

4. **Node**: aaPanel → App Store → Node.js version manager → install **Node 24** (or ≥22).  
   Confirm on SSH: `node -v`

---

## 2) Server — first clone (SSH as root)

```bash
# Wipe aaPanel placeholder files, keep the folder
cd /www/wwwroot/notch.sagartiwari.net
find . -mindepth 1 -delete

# PRIVATE repo: use a deploy token or SSH key
git clone https://github.com/<YOU>/notchos-web.git .

chmod +x deploy/reset-server.sh
```

---

## 3) Server — secrets (not in git)

```bash
mkdir -p /www/server/notchos/mail
chmod 700 /www/server/notchos

# Copy from your Mac (run these ON THE MAC):
#   scp "/Volumes/Samsung 1TB/REA/notchos-web/deploy/secrets/ed25519-private.pem" root@YOUR_SERVER:/www/server/notchos/
#   scp "/Volumes/Samsung 1TB/REA/notchos-web/deploy/secrets/key-enc.secret" root@YOUR_SERVER:/tmp/key-enc.secret

# On the server:
chmod 600 /www/server/notchos/ed25519-private.pem
chown www:www /www/server/notchos/ed25519-private.pem

cp /www/wwwroot/notch.sagartiwari.net/deploy/env.production.example /www/server/notchos/api.env
cp /www/wwwroot/notch.sagartiwari.net/deploy/env.migrate.example /www/server/notchos/migrate.env
chmod 600 /www/server/notchos/api.env /www/server/notchos/migrate.env
```

Edit both env files:

```bash
nano /www/server/notchos/api.env
nano /www/server/notchos/migrate.env
```

Set at least:

- `DB_PASSWORD` / `DB_MIGRATE_PASSWORD` → your MariaDB password  
- `KEY_ENC_SECRET` → contents of `key-enc.secret` (one line)  
- `SIGNING_KEY_FILE=/www/server/notchos/ed25519-private.pem`  
- leave `PORT=4391`

```bash
# After pasting KEY_ENC_SECRET:
rm -f /tmp/key-enc.secret
chown www:www /www/server/notchos/api.env
```

---

## 4) systemd

```bash
cp /www/wwwroot/notch.sagartiwari.net/deploy/notchos-api.service /etc/systemd/system/
# If `node` is not /usr/bin/node, fix ExecStart (which node)
systemctl daemon-reload
systemctl enable notchos-api
```

---

## 5) Nginx

aaPanel → Site `notch.sagartiwari.net` → **Config**.

Merge locations from `deploy/nginx-notch.sagartiwari.net.conf` (keep aaPanel SSL certificate lines).  
Or set **Reverse proxy** carefully so `/v1/` and `/api/` go to `http://127.0.0.1:4391` and document root stays `.../public`.

```bash
nginx -t && nginx -s reload
# aaPanel: Website → Reload
```

---

## 6) Build + migrate + start

```bash
cd /www/wwwroot/notch.sagartiwari.net
./deploy/reset-server.sh
systemctl start notchos-api
curl -sS https://notch.sagartiwari.net/v1/health
```

---

## 7) Upload the DMG

On the Mac (after `make dmg-staging`):

```bash
scp "/Volumes/Samsung 1TB/REA/Lumen/dist/NotchOS-0.7.0.dmg" \
  root@YOUR_SERVER:/www/wwwroot/notch.sagartiwari.net/public/downloads/NotchOS-0.7.0.dmg
```

On the server:

```bash
chown www:www /www/wwwroot/notch.sagartiwari.net/public/downloads/NotchOS-0.7.0.dmg
curl -sSIL https://notch.sagartiwari.net/downloads/NotchOS-0.7.0.dmg | head
```

---

## 8) Real license (not mock admin)

Admin at `/admin/` is still **in-browser mock**. Real keys:

```bash
cd /www/wwwroot/notch.sagartiwari.net/api
export NOTCHOS_ENV_FILE=/www/server/notchos/api.env
npm run license:create -- sagartiwari282@gmail.com lifetime
# Copy the printed NOS-… key into the Mac app.
```

---

## 9) Mac app pointing at this host

```bash
cd "/Volumes/Samsung 1TB/REA/Lumen"
make dmg-staging
# Install that DMG, then Activate with the CLI-created email + key.
```

---

## Updates later

```bash
cd /www/wwwroot/notch.sagartiwari.net
git pull origin main
./deploy/reset-server.sh
# re-upload DMG only when the app binary changes
```

---

## When you buy the final domain

1. Point DNS + SSL at the same stack (or migrate files).  
2. Change `SITE_URL` / `DOWNLOAD_URL` / `PRICING_URL` in `api.env`.  
3. Change `LicenseConfig` staging URLs (or ship `#else` production keys).  
4. Rebuild the Mac app once.

---

## Security notes

- DB password appeared in chat — **rotate it in aaPanel** after first successful deploy.  
- Never commit `api.env`, `*.pem`, or `key-enc.secret`.  
- Do not open firewall port 4391 to the world; only nginx → loopback.
