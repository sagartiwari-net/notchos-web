# NotchOS web

Marketing site, license API, and admin UI.

| Package | Role |
|---|---|
| `site/` | Astro static marketing + download |
| `api/` | Fastify license / trial API + CLI |
| `admin/` | Support panel (mock until phase W2) |
| `db/migrations/` | MariaDB schema |
| `deploy/` | aaPanel / nginx / systemd for `notch.sagartiwari.net` |

## Temporary public host

See **[deploy/SERVER.md](deploy/SERVER.md)** for step-by-step commands on aaPanel.

- Site: `https://notch.sagartiwari.net/`
- API: `https://notch.sagartiwari.net/v1/`
- DMG: `https://notch.sagartiwari.net/downloads/NotchOS-0.7.0.dmg`
- Admin: `https://notch.sagartiwari.net/admin/` (mock — use `api` CLI for real licenses)

## Local development

See `api/README.md`. Typical ports: API `4310`, admin `4311`, site `4312`, stable API `4320`.
