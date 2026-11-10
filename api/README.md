# NotchOS API

The license server for NotchOS: the routes the Mac app talks to (`/v1/*`), a command line
for manual licenses, and the database migrations. Phase W1 of `NOTCHOS-WEB-PLAN.md`.
PayPal, email and the admin routes are added by later phases.

- Node 24, TypeScript, Fastify 5, MariaDB 10.11.
- The sources run directly on Node (built-in type stripping): no build step in development.
- Everything is local. Servers listen on `127.0.0.1` only.

Contents: [Run it](#run-it) · [Wire contract](#wire-contract) · [Command line](#command-line) ·
[Configuration and secrets](#configuration-and-secrets) · [Database](#database) ·
[Tests](#tests) · [Stable copy](#stable-copy-for-the-mac-app) · [Code layout](#code-layout)

---

## Run it

All paths are relative to the repository root unless a command starts with `cd api`.

```sh
# 1. Private MariaDB on 127.0.0.1:3307 (data in ~/.notchos-dev/mariadb).
#    The first run creates the data dir, the databases, the users and the env files.
scripts/dev-db.sh start          # also: stop | status

# 2. Dev signing key (once). Prints the kid and the public key for the app.
node scripts/gen-signing-key.ts

# 3. The API.
cd api
npm install
npm run db:migrate               # apply db/migrations to notchos_dev
npm run dev                      # http://127.0.0.1:4310, restarts when a file changes
```

Other commands, all inside `api/`:

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run the API from the sources with file watching |
| `npm run build` then `npm start` | Compile to `dist/` and run the compiled code |
| `npm test` | All tests (needs the private MariaDB running) |
| `npm run typecheck` | Type-check the API, the tests and `scripts/*.ts` |
| `npm run db:migrate` | Apply pending migrations to the configured database |
| `npm run db:status` | Show applied and pending migrations |
| `npm run db:reset` | Drop and recreate **only** `notchos_dev`, then migrate. Refuses any other database |
| `npm run cli -- <command> ...` | The command line, see [Command line](#command-line) |

Quick check that it is up:

```sh
curl -s http://127.0.0.1:4310/v1/health
# {"status":"ok","server_time":"2026-11-10T03:36:14Z"}
```

`npm run dev` belongs in a terminal. For scripted checks, and for tools that only need
the API to be up (the admin dev server proxies to it), run it as a background process:

```sh
scripts/dev-api.sh start         # same port and database, no file watching; also: stop | status
```

It is detached from the calling shell and found again through a pid file; its log is
`~/.notchos-dev/log/api-dev.log`. Only one of the two can use port 4310 at a time.

---

## Wire contract

This section is the contract between the server and the Mac app.

### Basics

- Base URL: `http://127.0.0.1:4310` in development, `http://127.0.0.1:4320` for the
  [stable copy](#stable-copy-for-the-mac-app), `https://api.<domain>` in production.
- Requests are `POST` with `Content-Type: application/json` and a JSON object as body, at
  most 4096 bytes. Anything else is refused (`415`, `413`, `400`).
- Fields the server does not know are ignored. Types are never converted: `"true"` is not
  `true`.
- Every answer is a JSON object and carries `server_time`. Answers must not be cached
  (`Cache-Control: no-store`).
- A success is HTTP `200`. Everything else is an error object:

  ```json
  { "error": "already_active", "message": "This license is active on another Mac.", "server_time": "2026-11-10T03:36:27Z" }
  ```

  The app acts on the HTTP status and on `error`. `message` is English text for developers
  and may change; do not show it to users and do not parse it.

### Dates

One encoding everywhere (token fields, `server_time`, every date in an answer):
**ISO 8601, UTC, whole seconds, with a trailing `Z`**, for example `2026-11-10T03:36:27Z`.
Always exactly 20 characters, never fractional seconds, never an offset. A date that does
not apply is JSON `null` (only `expires_at` of a lifetime license).

In Swift this is `ISO8601DateFormatter()` with its default options, or
`JSONDecoder.DateDecodingStrategy.iso8601`.

### The token

```
token = base64url(payload) + "." + base64url(signature)
```

- `payload` is the UTF-8 bytes of one JSON object (below).
- `signature` is the Ed25519 signature (64 bytes) over **exactly those payload bytes**.
- `base64url` is RFC 4648 section 5 without `=` padding.

To verify: split at the dot, base64url-decode both parts, check the signature over the
decoded payload bytes with the public key named by `kid`, and only then parse the bytes as
JSON. Never re-serialise the JSON before checking. `scripts/verify-token.swift` does
exactly this with CryptoKit and can be used as a reference:

```sh
swift scripts/verify-token.swift <token> <public-key-base64>     # prints the payload and VALID or INVALID
```

Payload:

```json
{
  "kid": "88aa333ddffb5a82",
  "license_id": 12,
  "device_id": "<the device id the app sent>",
  "plan": "lifetime",
  "issued_at": "2026-11-10T03:36:27Z",
  "expires_at": null,
  "refresh_by": "2026-12-10T03:36:27Z"
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `kid` | string | Names the signing key. The app keeps a list of public keys and picks the one with this id |
| `license_id` | number or `null` | The license. `null` in a trial token (a trial has no license) |
| `device_id` | string | The device this token is bound to, exactly as the app sent it. A token whose `device_id` is not this Mac's is not valid here |
| `plan` | string | `monthly`, `lifetime` or `trial` |
| `issued_at` | date | The server's clock when the token was signed. It is inside the signature, so the app may treat it as a trusted "it is at least this late" |
| `expires_at` | date or `null` | Pro ends at this moment (`now < expires_at`). `null` for lifetime |
| `refresh_by` | date | The token is valid only while `now <= refresh_by`; the app must have refreshed online by then |

Dates per plan (LICENSE plan section 4):

| Plan | `expires_at` | `refresh_by` |
|------|--------------|--------------|
| `lifetime` | `null` | `issued_at` + 30 days; every refresh moves it forward |
| `monthly` | the license's expiry | the same date |
| `trial` | trial start + 7 days (setting `trial_days`) | the same date |

The key order inside the payload is not part of the contract, and later versions may add
fields: decode by name and ignore what you do not know.

`kid` is the first 16 hex characters of SHA-256 over the raw 32-byte public key. The public
key the app embeds is those raw 32 bytes in base64, printed by
`node scripts/gen-signing-key.ts` and saved in `~/.notchos-dev/signing/ed25519-public.txt`.
In Swift: `Curve25519.Signing.PublicKey(rawRepresentation:)`.

Success answers repeat `plan`, `expires_at` and `refresh_by` next to the token for
convenience. They are not signed: the app takes its entitlement from the verified token only.

### Common request fields

| Field | Type | Rules |
|-------|------|-------|
| `key` | string | The license key as the user pasted it. Case, spaces and dashes do not matter (`nos 7k2qf m9xpa…` is fine). Any string is accepted here; a string that is not a key answers `invalid_key` |
| `device_id` | string | 16 to 128 characters from `A-Z a-z 0-9 _ -`. Compared byte for byte, so always send the same spelling (recommended: lowercase hex of the SHA-256, 64 characters) |
| `device_name` | string, optional | The Mac's name, up to 255 characters. Control characters are removed and the first 100 characters are stored. It is shown to the owner on another Mac and in the admin |
| `app_version` | string, optional | Up to 64 characters; the first 32 are stored |

### Errors that every POST route can answer

| HTTP | `error` | When | Extra fields |
|------|---------|------|--------------|
| 400 | `bad_request` | Body is not valid JSON, a required field is missing, or a field has the wrong type or shape. `message` names the rule | |
| 413 | `payload_too_large` | Body above 4096 bytes | |
| 415 | `unsupported_media_type` | `Content-Type` is not `application/json` | |
| 429 | `rate_limited` | Too many requests from this address, for this key, or for this device (see [Rate limits](#rate-limits)) | `retry_after` (seconds, also in the `Retry-After` header) |
| 500 | `server_error` | The server failed. Nothing was changed; try again later | |
| 404 | `not_found` | No such route (also a `GET` on a `POST` route) | |

Bytes that are not an HTTP request at all are answered in the same JSON shape
(`bad_request`, with `server_time`) and status `400`, `408` (request not completed in
time) or `431` (headers too large), and the connection is closed.

### POST /v1/activate

Turns a key into a token for this Mac.

Request:

```json
{ "email": "buyer@paypal.com", "key": "NOS-7K2QF-M9XPA-4HRTD-W8ZC3", "device_id": "…", "device_name": "Sagar's MacBook Pro", "app_version": "1.0.0", "transfer": false }
```

`email`, `key` and `device_id` are required. The email must match the license (trim +
case-insensitive); a wrong email answers `invalid_key` exactly like a wrong key.
`transfer` (boolean, default `false`) asks the server to move the seat to this Mac if
another Mac holds it.

`200`:

```json
{
  "token": "eyJraWQiOi…",
  "plan": "lifetime",
  "expires_at": null,
  "refresh_by": "2026-12-10T03:36:27Z",
  "transferred": false,
  "transfers_left": 2,
  "server_time": "2026-11-10T03:36:27Z"
}
```

`transferred` is `true` when this call moved the seat away from another Mac.
`transfers_left` is how many moves the license still has.

What the server does, inside one database transaction with the license row locked:

1. The key exists, is not revoked and has not expired; otherwise the matching error.
2. This Mac already holds a seat (reinstall, repeated call): a new token, nothing else
   changes, no transfer is used.
3. A seat is free: this Mac takes it.
4. Every seat is taken by other Macs: `already_active`. With `transfer: true` and transfers
   left, the Mac seen least recently loses its seat to this one and one transfer is used;
   with none left, `transfer_limit_reached`.

Errors:

| HTTP | `error` | When | Extra fields |
|------|---------|------|--------------|
| 404 | `invalid_key` | The key is unknown or is not a key at all. Both cases answer identically | |
| 403 | `revoked` | The license was revoked (refund) | |
| 403 | `expired` | The license has expired | `expires_at` |
| 409 | `already_active` | Another Mac holds the seat and `transfer` was not `true` | `device_name` (string or `null`), `activated_at`, `transfers_left` |
| 409 | `transfer_limit_reached` | `transfer: true`, but no transfer is left | the same three fields, `transfers_left` is `0` |

```json
{
  "error": "already_active",
  "message": "This license is active on another Mac.",
  "device_name": "Sagar's MacBook Pro",
  "activated_at": "2026-11-10T03:36:27Z",
  "transfers_left": 2,
  "server_time": "2026-11-13T09:00:00Z"
}
```

`device_name` and `activated_at` describe the Mac that holds the seat (the one a transfer
would replace). Offer "move it to this Mac" only when `transfers_left` is above `0`.

### POST /v1/refresh

A fresh token for a Mac that holds a seat. This is how the app learns about renewals
(a later `expires_at`), refunds and seat moves. Call it on launch, once a day and near
expiry.

Request: `{ "key": "…", "device_id": "…", "device_name": "…", "app_version": "…" }`
(`key` and `device_id` required; a name or version that is sent replaces the stored one).

`200`:

```json
{ "token": "eyJraWQiOi…", "plan": "monthly", "expires_at": "2026-12-10T03:36:27Z", "refresh_by": "2026-12-10T03:36:27Z", "server_time": "2026-11-10T03:36:27Z" }
```

Errors, checked in this order:

| HTTP | `error` | When | What the app does | Extra fields |
|------|---------|------|-------------------|--------------|
| 404 | `invalid_key` | Unknown key | Pro off, forget the key | |
| 403 | `revoked` | The license was revoked | Pro off | |
| 409 | `seat_moved` | This Mac holds no seat for this key: it was moved to another Mac, deactivated, freed by the admin, or never activated | Pro off; activating again is possible | |
| 403 | `expired` | The license has expired | Pro off, offer renewal | `expires_at` |

### POST /v1/deactivate

Frees this Mac's seat ("Deactivate this Mac").

Request: `{ "key": "…", "device_id": "…" }` (both required).

`200`: `{ "deactivated": true, "server_time": "…" }`. `deactivated` is `false` when this Mac
held no seat, so the call can be repeated safely. It also works for a revoked or expired
license. The only license error is `404 invalid_key`.

After a deactivation the seat is free: the next activation on any Mac is a normal
activation and uses no transfer.

### POST /v1/trial

Starts, or continues, the free trial of this Mac. No key, no email.

Request: `{ "device_id": "…", "app_version": "1.0.0" }` (`device_id` required).

`200`, on the first call and on every later call while the trial is running:

```json
{
  "token": "eyJraWQiOi…",
  "plan": "trial",
  "started_at": "2026-11-10T03:36:27Z",
  "expires_at": "2026-11-17T03:36:27Z",
  "refresh_by": "2026-11-17T03:36:27Z",
  "server_time": "2026-11-10T03:36:27Z"
}
```

The first call fixes `started_at` and `expires_at` in the database. A later call from the
same `device_id` (reinstall, wiped Keychain) returns the same two dates and a token that
ends on the same date; only the token's `issued_at` is the time of the call. There is
never a second trial for a device.

After the trial has ended:

| HTTP | `error` | Extra fields |
|------|---------|--------------|
| 409 | `trial_used` | `started_at`, `expires_at` (the original dates). No token |

### GET /v1/health

`200` `{ "status": "ok", "server_time": "…" }` when the API and its database answer;
`503` `{ "error": "unavailable", … }` otherwise. Not rate limited.

### Rate limits

Counted in fixed windows of `RATE_LIMIT_WINDOW_SEC` seconds (default 60):

- per client address: `RATE_LIMIT_IP_MAX` requests (default 30) across the four POST routes;
- per license key: `RATE_LIMIT_KEY_MAX` requests (default 10) across activate, refresh and
  deactivate, whatever address they come from;
- per device id on `/v1/trial`: the same `RATE_LIMIT_KEY_MAX`.

Over the limit the answer is `429 rate_limited` with `retry_after` seconds and a
`Retry-After` header. The app should wait that long and must not treat it as a license
problem (Pro stays as the stored token says).

### What the app can rely on

- The same key on the same `device_id` always activates again (test row 11).
- A revoked license never yields a token again (row 10); an edited token never verifies
  (row 5); a second trial has the dates of the first (row 13).
- `server_time` and the token's `issued_at` come from the same server clock.
- Logs on the server never contain a key or a token.

---

## Command line

```sh
cd api
npm run cli -- --help
npm run cli -- license:create <email> <monthly|lifetime> [--days N | --minutes N] [--note TEXT]
npm run cli -- license:revoke <license id | key>
npm run cli -- license:reset-seat <license id | key> [--reset-transfers]
npm run cli -- license:list [--email PART] [--status active|revoked] [--plan monthly|lifetime] [--limit N] [--json]
npm run cli -- db:migrate | db:status | db:reset
```

Each license command also has its own npm script, so `npm run license:create -- a@b.com lifetime`
works too. The `--` is needed whenever an option such as `--days` follows.

- `license:create` prints the key once. It is not stored in clear text anywhere and cannot
  be shown again by this command line. A monthly license lasts 30 days unless `--days` or
  `--minutes` says otherwise (`--minutes` exists for testing expiry). `source` is `manual`.
- `license:revoke` sets the license to `revoked`: the Mac loses Pro on its next refresh.
  Prefer the id: a key typed on a command line ends up in the shell history.
- `license:reset-seat` frees every seat of the license (support: "my Mac died"). The next
  activation uses no transfer. `--reset-transfers` also sets the transfer counter to zero.
- `license:list` never shows a key, only its last 4 characters.

Exit codes: `0` done, `1` failed (for example "No such license."), `2` wrong usage.

To add a command (for example `admin:create`): export a `Command` from a file in
`src/cli/commands/` and add it to `COMMANDS` in `src/cli/index.ts`.

---

## Configuration and secrets

`api/.env.example` lists every variable. No real value is ever in the repository.

The API reads an env file and then the real environment (which wins):

1. the file named by `NOTCHOS_ENV_FILE`, if set (an empty value means "no file");
2. otherwise, in development only (`NODE_ENV` unset or `development`),
   `~/.notchos-dev/env/dev.env` if it exists.

The migration commands additionally read `NOTCHOS_MIGRATE_ENV_FILE` (in development
`~/.notchos-dev/env/dev-migrate.env`). The running API never loads that file.

Why the env files live in `~/.notchos-dev` and not in `api/.env`: the repository is on a
volume where file ownership is not enforced, so a secret there could not be protected.
`~/.notchos-dev` is on the internal disk with mode 700, and the API refuses to read an env
file or a signing key that other users can read.

What `~/.notchos-dev` holds (created by `scripts/dev-db.sh start` and
`node scripts/gen-signing-key.ts`):

| Path | Content |
|------|---------|
| `mariadb/` | data dir of the private MariaDB |
| `run/` `log/` `tmp/` | socket and pid files, logs, temp files |
| `env/dev.env` | the dev API: database password of `notchos_dev_api`, `KEY_ENC_SECRET`, path of the signing key |
| `env/dev-migrate.env` | password of `notchos_dev_migrate` |
| `env/test.env` | passwords of the two test users |
| `signing/ed25519-private.pem` | the dev signing key (secret) |
| `signing/ed25519-public.txt` | its `kid` and public key (public) |
| `api-stable/` | the stable copy: `env/` (its own two env files) and `current/` (the snapshot) |

The secrets are generated with `openssl rand` and are never printed. `dev-db.sh` writes an
env file only if it does not exist, so lines added later are kept.

Three things the code enforces about its environment:

- `HOST` must be `127.0.0.1` or `::1`.
- The process runs in UTC. The MariaDB driver converts dates with the time zone of the
  Node process, so `src/db/pool.ts` sets `TZ=UTC` and refuses to connect if that did not
  take effect. Every database session also runs with `time_zone = '+00:00'`.
- In production set `TRUST_PROXY=loopback`, so that the client address comes from Nginx's
  `X-Forwarded-For`. Without it every client shares one rate-limit bucket (the API logs a
  warning at startup).

---

## Database

One private MariaDB 10.11 instance (`scripts/dev-db.sh`), three kinds of database:

| Database | Used by | Migration user (all rights on that database) | Runtime user (SELECT, INSERT, UPDATE, DELETE only) |
|----------|---------|------------------|----------------|
| `notchos_dev` | development, port 4310 | `notchos_dev_migrate` | `notchos_dev_api` |
| `notchos_app` | the stable copy, port 4320 | `notchos_app_migrate` | `notchos_app_api` |
| `notchos_test_*` | the tests; created and dropped by them | `notchos_test_admin` | `notchos_test_api` |

No user can reach a database that is not its own. The admin of the instance is the macOS
user over the private socket (`unix_socket` authentication): there is no admin password.

Migrations are plain SQL files in `db/migrations`, named `NNN_description.sql`, applied
in order and recorded in the table `schema_migrations` with a checksum.

- To change the schema, add the next file (`002_…sql`). Never edit a file that has been
  applied: the runner compares checksums and refuses.
- Write files so that running them twice is harmless (`CREATE TABLE IF NOT EXISTS`):
  MariaDB commits DDL statement by statement.
- The API refuses to start while its database is missing a migration.

Conventions in the code: values always travel as query parameters; every `DATETIME` is
UTC with whole seconds; the API's clock, not `NOW()`, is the source of time (tests run on
a fake clock); the seats of a license are only read or written while its `licenses` row is
locked with `SELECT … FOR UPDATE` (see the header of `src/services/activation.ts`).

---

## Tests

```sh
scripts/dev-db.sh start      # once
cd api && npm test           # add  -- --reporter=verbose  to list every test
```

Vitest. Every test file creates its own database `notchos_test_<time>_<random>`, migrates
it, runs the API in-process as the DML-only user with a fake clock, and drops the database
at the end. Leftovers of a crashed run are removed by the next run once they are an hour old.

Where the plan's test rows are covered:

| Plan item | Test file |
|-----------|-----------|
| Row 2, valid key activates | `test/activate.test.ts` |
| Row 3, second Mac refused, transfer offered | `test/activate.test.ts` |
| Row 5, edited token rejected (Node and CryptoKit) | `test/signing.test.ts`, `test/verify-token-swift.test.ts` |
| Row 10, refund: refresh fails | `test/refresh-deactivate.test.ts`, `test/cli.test.ts` |
| Row 11, reinstall on the same Mac, no transfer | `test/activate.test.ts` |
| Row 13, second trial has the same dates | `test/trial.test.ts` |
| Transfer limit, expired key, wrong key | `test/activate.test.ts` |
| Rate limit | `test/rate-limit-http.test.ts`, `test/rate-limit.test.ts` |
| `server_time` in every answer, validation, body limits | `test/http-contract.test.ts` |
| No key, token or secret in logs | `test/logging.test.ts` |
| Key generator, hash, encrypted copy | `test/license-key.test.ts` |
| Migrations, schema, database users, UTC | `test/migrate.test.ts` |
| CLI | `test/cli.test.ts` |
| Configuration | `test/config.test.ts` |

`test/verify-token-swift.test.ts` runs `scripts/verify-token.swift` and is skipped where
no Swift toolchain is installed.

---

## Stable copy (for the Mac app)

`api/` keeps changing; the Mac app is tested against a frozen copy.

```sh
scripts/stable-api.sh snapshot     # build api/ and copy it to ~/.notchos-dev/api-stable/current
scripts/stable-api.sh start        # http://127.0.0.1:4320, database notchos_app
scripts/stable-api.sh status       # exit 0 running, 3 stopped
scripts/stable-api.sh stop
scripts/stable-api.sh cli license:create tester@example.com lifetime
scripts/stable-api.sh cli license:create tester@example.com monthly --days 2
scripts/stable-api.sh cli license:list
```

- The copy is self-contained (compiled code, production `node_modules`, migrations, its
  own env files), holds no symlinks and does not depend on the repository once taken.
- It has its own database and users, and signs with the same dev key as the development
  API, so the app needs one public key for both.
- `snapshot` and `start` apply pending migrations to `notchos_app`. A new snapshot replaces
  the code only; the data in `notchos_app` stays. If the copy is running, `snapshot`
  restarts it on the new code.
- `cli` runs the snapshot's own command line against `notchos_app`. `db:reset` refuses there.
- Its settings are in `~/.notchos-dev/api-stable/env/api.env`. Host, port and database are
  fixed by the script. To loosen the rate limits while testing the app, add for example
  `RATE_LIMIT_IP_MAX=600` and `RATE_LIMIT_KEY_MAX=120` there, then `stop` and `start`.
- Its log is `~/.notchos-dev/log/api-stable.log`.

---

## Code layout

```
api/
  src/
    server.ts            process entry: config -> signing key -> database check -> listen
    app.ts               builds the Fastify app: logging, error handling, route groups
    config.ts            env files and validation
    context.ts           the shared objects handed to routes, services and CLI commands
    routes/v1.ts         the app-facing routes (this contract)
    http/respond.ts      answer shapes and the list of error names
    services/            activation.ts  trials.ts  licenses.ts  tokens.ts  settings.ts  events.ts
    crypto/              license-key.ts (generate, hash, encrypt)   signing.ts (Ed25519 tokens)
    db/                  pool.ts (connections, transactions)   migrate.ts (migration runner)
    lib/                 time.ts (clock, date encoding)   rate-limit.ts
    cli/                 index.ts (entry)   command.ts   commands/license.ts   commands/db.ts
  test/                  one file per area, helpers/ for the throwaway-database harness
db/migrations/           001_init.sql (all tables of WEB plan section 4)
scripts/                 dev-db.sh  dev-api.sh  stable-api.sh  gen-signing-key.ts  verify-token.swift  lib/
```

Adding to it:

- **A route group** (for example `/admin/*`): write a Fastify plugin like `routes/v1.ts`
  that takes `{ ctx }`, and register it with its prefix in `app.ts`. The error handler,
  the 404 handler and the response headers already apply to it. Use `sendOk` / `sendError`
  and add new error names to `API_ERRORS` in `http/respond.ts`.
- **Database work**: take a `Queryable` (the pool or a transaction) as a parameter, use
  `selectRows` / `selectOne` / `write` with `?` parameters, and `withTransaction` for
  anything that changes more than one row. Lock the license first when seats are involved.
- **A migration**: `db/migrations/002_….sql`, then `npm run db:migrate`.
- **A CLI command**: see [Command line](#command-line).
- TypeScript must stay erasable (no `enum`, no parameter properties, no namespaces) and
  relative imports carry `.ts`; `npm run typecheck` enforces both.
