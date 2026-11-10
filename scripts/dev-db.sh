#!/bin/bash
# NotchOS private development database (MariaDB 10.11).
#
#   scripts/dev-db.sh start    first run: create the data dir; then start the server and
#                              make sure the project databases, users and env files exist
#   scripts/dev-db.sh stop     clean shutdown
#   scripts/dev-db.sh status   state, process line, listener, data dir (exit 3 when stopped)
#
# The instance is private to this project:
#   binaries   /opt/homebrew/opt/mariadb@10.11/bin   (never through `brew services`)
#   data dir   ~/.notchos-dev/mariadb
#   socket     ~/.notchos-dev/run/mariadb.sock       (never /tmp/mysql.sock)
#   TCP        127.0.0.1:3307 only
# The server and every client call use --no-defaults, so /opt/homebrew/etc/my.cnf is never
# read, and nothing here points at /opt/homebrew/var/mysql (another project's MySQL 8 data).
#
# Databases:  notchos_dev (development)   notchos_app (stable API copy)
#             notchos_test_*              (created and dropped by the API tests)
# Users (all @127.0.0.1, password login over TCP):
#   notchos_dev_migrate   all privileges on notchos_dev only        (migrations, db:reset)
#   notchos_dev_api       SELECT/INSERT/UPDATE/DELETE on notchos_dev only   (the API)
#   notchos_app_migrate   all privileges on notchos_app only
#   notchos_app_api       SELECT/INSERT/UPDATE/DELETE on notchos_app only   (the stable copy)
#   notchos_test_admin    all privileges on databases named notchos_test_* only
#   notchos_test_api      SELECT/INSERT/UPDATE/DELETE on notchos_test_* only
# Admin access is the macOS user over the private socket (unix_socket plugin): no admin
# password exists. The generated passwords and secrets are written once to env files in
# ~/.notchos-dev (mode 600) and are never printed.
#
# This script never drops a database and never deletes the data dir.
# To recreate only notchos_dev:  cd api && npm run db:reset

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/dev-common.sh
. "$SCRIPT_DIR/lib/dev-common.sh"

usage() {
  sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

require_binaries() {
  local bin
  for bin in mariadbd mariadb mariadb-admin mariadb-install-db; do
    [ -x "$MARIADB_BIN/$bin" ] || die "$MARIADB_BIN/$bin not found (MariaDB 10.11 from Homebrew is required)"
  done
  # The client reports the distribution version without opening any data dir.
  "$MARIADB_BIN/mariadb" --no-defaults --version | grep -q 'Distrib 10\.11\.' \
    || die "$MARIADB_BIN is not MariaDB 10.11"
  command -v openssl >/dev/null || die "openssl is not on PATH (needed to generate dev secrets)"
  command -v lsof >/dev/null || die "lsof is not on PATH"
}

prepare_dirs() {
  private_dir "$NOTCHOS_DEV_HOME"
  private_dir "$DB_RUN_DIR"
  private_dir "$DB_LOG_DIR"
  private_dir "$DB_TMP_DIR"
  private_dir "$ENV_DIR"
  private_dir "$STABLE_DIR"
  private_dir "$STABLE_ENV_DIR"
}

# First run only: create the system tables in the private data dir.
init_datadir() {
  if [ -d "$DB_DATADIR/mysql" ]; then
    return 0
  fi
  if [ -d "$DB_DATADIR" ] && [ -n "$(ls -A "$DB_DATADIR")" ]; then
    die "$DB_DATADIR exists, is not empty and holds no MariaDB system tables. Not touching it."
  fi
  echo "Creating the private data dir $DB_DATADIR ..."
  private_dir "$DB_DATADIR"
  # --no-defaults: read no option file.
  # --skip-test-db: no `test` database and no anonymous accounts.
  # --cross-bootstrap: put no reference to this Mac's host name into the system tables
  #   (the name changes with the network; accounts here use localhost and 127.0.0.1 only).
  # Admin accounts authenticate with the unix_socket plugin only: root (OS root) and the
  # current macOS user. Neither has a password, so neither can log in over TCP.
  if ! "$MARIADB_BIN/mariadb-install-db" --no-defaults \
      --basedir="$MARIADB_BASEDIR" \
      --datadir="$DB_DATADIR" \
      --tmpdir="$DB_TMP_DIR" \
      --auth-root-authentication-method=socket \
      --auth-root-socket-user="$(id -un)" \
      --skip-test-db \
      --cross-bootstrap \
      > "$DB_LOG_DIR/install-db.log" 2>&1; then
    tail -n 30 "$DB_LOG_DIR/install-db.log" >&2 || true
    die "mariadb-install-db failed (full log: $DB_LOG_DIR/install-db.log)"
  fi
  [ -d "$DB_DATADIR/mysql" ] || die "mariadb-install-db did not create $DB_DATADIR/mysql"
}

start_server() {
  local listeners pid i
  listeners="$(port_listeners "$DB_PORT")"
  if [ -n "$listeners" ]; then
    printf '%s\n' "$listeners" >&2
    die "port $DB_PORT is already in use by the process above"
  fi

  echo "Starting MariaDB on $DB_HOST:$DB_PORT ..."
  # Every path and the listener are given explicitly; no option file is read. The server
  # gets a clean environment so that MYSQL_* variables of the calling shell cannot leak in.
  pid="$(env -i HOME="$HOME" USER="$(id -un)" LOGNAME="$(id -un)" \
      PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$DB_TMP_DIR" \
      "$NODE_BIN" "$COMMON_LIB_DIR/detach.mjs" "$DB_LOG_DIR/mariadb.out" \
      "$MARIADB_BIN/mariadbd" --no-defaults \
      --datadir="$DB_DATADIR" \
      --port="$DB_PORT" \
      --bind-address="$DB_HOST" \
      --socket="$DB_SOCKET" \
      --pid-file="$DB_PID_FILE" \
      --log-error="$DB_ERROR_LOG" \
      --basedir="$MARIADB_BASEDIR" \
      --tmpdir="$DB_TMP_DIR" \
      --character-set-server=utf8mb4 \
      --collation-server=utf8mb4_unicode_ci \
      --default-time-zone=+00:00 \
      --skip-name-resolve \
      --local-infile=0)"

  i=0
  while [ "$i" -lt 120 ]; do
    if db_ping; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 30 "$DB_ERROR_LOG" >&2 || true
      die "mariadbd exited during startup (log: $DB_ERROR_LOG)"
    fi
    sleep 0.25
    i=$((i + 1))
  done
  tail -n 30 "$DB_ERROR_LOG" >&2 || true
  die "mariadbd did not answer within 30 s (log: $DB_ERROR_LOG)"
}

rand_hex() {
  openssl rand -hex "$1"
}

# Write an env file only if it does not exist yet. Existing files are never rewritten, so
# values added later by hand (or by a later phase) are kept.
write_env_once() {
  local path="$1" content="$2"
  if [ -e "$path" ]; then
    return 0
  fi
  printf '%s\n' "$content" > "$path.tmp.$$"
  chmod 600 "$path.tmp.$$"
  mv "$path.tmp.$$" "$path"
  echo "  created $path"
}

ensure_env_files() {
  write_env_once "$ENV_DIR/dev.env" "# NotchOS API, development (port 4310, database notchos_dev).
# Generated by scripts/dev-db.sh. Not in git. Keep mode 600.
# Every variable is explained in api/.env.example.
NODE_ENV=development
HOST=127.0.0.1
PORT=4310
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=notchos_dev
DB_USER=notchos_dev_api
DB_PASSWORD=$(rand_hex 24)
KEY_ENC_SECRET=$(openssl rand -base64 32)
SIGNING_KEY_FILE=$SIGNING_KEY_FILE"

  write_env_once "$ENV_DIR/dev-migrate.env" "# Migration user for notchos_dev. Used only by db:migrate and db:reset, never by the API.
# Generated by scripts/dev-db.sh. Not in git. Keep mode 600.
DB_MIGRATE_USER=notchos_dev_migrate
DB_MIGRATE_PASSWORD=$(rand_hex 24)"

  write_env_once "$ENV_DIR/test.env" "# Database users for the API tests (throwaway databases notchos_test_* only).
# Generated by scripts/dev-db.sh. Not in git. Keep mode 600.
TEST_DB_HOST=$DB_HOST
TEST_DB_PORT=$DB_PORT
TEST_DB_ADMIN_USER=notchos_test_admin
TEST_DB_ADMIN_PASSWORD=$(rand_hex 24)
TEST_DB_API_USER=notchos_test_api
TEST_DB_API_PASSWORD=$(rand_hex 24)"

  write_env_once "$STABLE_ENV_DIR/api.env" "# NotchOS stable API copy (port 4320, database notchos_app). See scripts/stable-api.sh.
# Generated by scripts/dev-db.sh. Not in git. Keep mode 600.
# Same dev signing key as the development API, so one public key verifies both.
NODE_ENV=development
HOST=127.0.0.1
PORT=4320
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=notchos_app
DB_USER=notchos_app_api
DB_PASSWORD=$(rand_hex 24)
KEY_ENC_SECRET=$(openssl rand -base64 32)
SIGNING_KEY_FILE=$SIGNING_KEY_FILE"

  write_env_once "$STABLE_ENV_DIR/migrate.env" "# Migration user for notchos_app (stable API copy). Never used by the running API.
# Generated by scripts/dev-db.sh. Not in git. Keep mode 600.
DB_MIGRATE_USER=notchos_app_migrate
DB_MIGRATE_PASSWORD=$(rand_hex 24)"
}

# Read a password from an env file and make sure it is safe to place in a SQL literal.
password_from() {
  local value
  value="$(env_value "$1" "$2")"
  case "$value" in
    '' ) die "$1 has no $2. Delete the file and run this script again to regenerate it." ;;
    *[!A-Za-z0-9]* ) die "$2 in $1 may only contain letters and digits." ;;
  esac
  [ "${#value}" -ge 16 ] || die "$2 in $1 is too short (16 characters or more)."
  printf '%s' "$value"
}

# SQL for one account: create it, set the password from the env file, set exactly these
# privileges. In a database-level GRANT, _ and % are wildcards, so underscores are escaped.
sql_user() {
  printf "CREATE USER IF NOT EXISTS '%s'@'127.0.0.1' IDENTIFIED BY '%s';\n" "$1" "$2"
  printf "ALTER USER '%s'@'127.0.0.1' IDENTIFIED BY '%s';\n" "$1" "$2"
  printf "REVOKE ALL PRIVILEGES, GRANT OPTION FROM '%s'@'127.0.0.1';\n" "$1"
  printf "GRANT %s ON \`%s\`.* TO '%s'@'127.0.0.1';\n" "$3" "$4" "$1"
}

# Idempotent: databases, users and grants are brought to the state described at the top.
provision() {
  local dev_api dev_migrate app_api app_migrate test_admin test_api
  local dml='SELECT, INSERT, UPDATE, DELETE'

  ensure_env_files
  dev_api="$(password_from "$ENV_DIR/dev.env" DB_PASSWORD)"
  dev_migrate="$(password_from "$ENV_DIR/dev-migrate.env" DB_MIGRATE_PASSWORD)"
  app_api="$(password_from "$STABLE_ENV_DIR/api.env" DB_PASSWORD)"
  app_migrate="$(password_from "$STABLE_ENV_DIR/migrate.env" DB_MIGRATE_PASSWORD)"
  test_admin="$(password_from "$ENV_DIR/test.env" TEST_DB_ADMIN_PASSWORD)"
  test_api="$(password_from "$ENV_DIR/test.env" TEST_DB_API_PASSWORD)"

  # The SQL goes to the client on stdin, so no password appears in a process list.
  {
    printf '%s\n' "DROP USER IF EXISTS ''@'localhost';"
    printf '%s\n' "CREATE DATABASE IF NOT EXISTS \`notchos_dev\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    printf '%s\n' "CREATE DATABASE IF NOT EXISTS \`notchos_app\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    sql_user notchos_dev_migrate "$dev_migrate" 'ALL PRIVILEGES' 'notchos\_dev'
    sql_user notchos_dev_api     "$dev_api"     "$dml"           'notchos\_dev'
    sql_user notchos_app_migrate "$app_migrate" 'ALL PRIVILEGES' 'notchos\_app'
    sql_user notchos_app_api     "$app_api"     "$dml"           'notchos\_app'
    sql_user notchos_test_admin  "$test_admin"  'ALL PRIVILEGES' 'notchos\_test\_%'
    sql_user notchos_test_api    "$test_api"    "$dml"           'notchos\_test\_%'
  } | db_admin --batch
}

print_status() {
  local pid
  if ! pid="$(db_running_pid)"; then
    echo "MariaDB (private dev instance): not running"
    echo "  data dir  $DB_DATADIR"
    return 3
  fi
  echo "MariaDB (private dev instance): running, pid $pid"
  echo "  process   $(ps -o command= -p "$pid")"
  echo "  listener  $(port_listeners "$DB_PORT" | tr -s ' ')"
  db_admin --batch --skip-column-names -e \
    "SELECT CONCAT('  server    ', VERSION(), ', datadir ', @@datadir, ', port ', @@port,
                   ', bind ', @@bind_address, ', socket ', @@socket);
     SELECT CONCAT('  databases ', IFNULL(GROUP_CONCAT(schema_name ORDER BY schema_name SEPARATOR ' '), '(none)'))
       FROM information_schema.schemata WHERE schema_name LIKE 'notchos%';"
  echo "  env files $ENV_DIR/  and  $STABLE_ENV_DIR/"
}

cmd_start() {
  local pid
  require_binaries
  prepare_dirs
  if pid="$(db_running_pid)"; then
    echo "MariaDB is already running (pid $pid)."
  else
    init_datadir
    start_server
  fi
  provision
  print_status
}

cmd_stop() {
  local pid i
  if ! pid="$(db_running_pid)"; then
    echo "MariaDB (private dev instance) is not running."
    return 0
  fi
  echo "Stopping MariaDB (pid $pid) ..."
  # Clean shutdown through the private socket; SIGTERM (also a clean shutdown) as a fallback.
  db_admin_tool shutdown 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  i=0
  while kill -0 "$pid" 2>/dev/null; do
    [ "$i" -lt 240 ] || die "mariadbd (pid $pid) is still running after 60 s"
    sleep 0.25
    i=$((i + 1))
  done
  echo "Stopped."
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) print_status ;;
  *) usage ;;
esac
