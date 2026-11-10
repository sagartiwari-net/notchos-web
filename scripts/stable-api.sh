#!/bin/bash
# The stable API copy: a built snapshot of api/ that the Mac app is tested against, so
# app work is not disturbed while api/ keeps changing.
#
#   scripts/stable-api.sh snapshot           build api/ and copy it, with its production
#                                            dependencies and the migrations, to
#                                            ~/.notchos-dev/api-stable/current
#   scripts/stable-api.sh start              run that copy on http://127.0.0.1:4320
#   scripts/stable-api.sh stop
#   scripts/stable-api.sh status             exit 0 when running, 3 when stopped
#   scripts/stable-api.sh cli <command> ...  the copy's own command line, for example
#                                            cli license:create a@b.com monthly --days 2
#
# The copy is self-contained: built code, node_modules, migrations and env files all live
# in ~/.notchos-dev/api-stable, with no symlinks and nothing pointing back into the repo.
# It uses its own database, notchos_app, with its own database users, and the same dev
# signing key as the development API, so one public key verifies tokens from both.
#
# snapshot and start apply pending migrations to notchos_app. Nothing here ever drops or
# empties that database: a new snapshot only replaces the code.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/dev-common.sh
. "$SCRIPT_DIR/lib/dev-common.sh"

REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STABLE_CURRENT="$STABLE_DIR/current"
STABLE_ENTRY="$STABLE_CURRENT/api/dist/server.js"
STABLE_PID_FILE="$DB_RUN_DIR/api-stable.pid"
STABLE_LOG="$DB_LOG_DIR/api-stable.log"
STABLE_HOST="127.0.0.1"
STABLE_PORT="4320"
STABLE_DATABASE="notchos_app"
STABLE_URL="http://$STABLE_HOST:$STABLE_PORT"

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

# Run node for the copy with a clean environment: only what is listed here reaches it, so
# variables of the calling shell cannot change which database or port it uses. Host, port
# and database are fixed here and win over the env file.
#   stable_node      the server: it gets the API env file only
#   stable_cli_node  the command line: it is also told where the migration credentials
#                    are (only db:migrate reads them)
stable_node() {
  env -i HOME="$HOME" PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
    NOTCHOS_ENV_FILE="$STABLE_ENV_DIR/api.env" \
    NOTCHOS_MIGRATE_ENV_FILE="" \
    HOST="$STABLE_HOST" PORT="$STABLE_PORT" DB_NAME="$STABLE_DATABASE" \
    "$NODE_BIN" "$@"
}

stable_cli_node() {
  env -i HOME="$HOME" PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
    NOTCHOS_ENV_FILE="$STABLE_ENV_DIR/api.env" \
    NOTCHOS_MIGRATE_ENV_FILE="$STABLE_ENV_DIR/migrate.env" \
    HOST="$STABLE_HOST" PORT="$STABLE_PORT" DB_NAME="$STABLE_DATABASE" \
    "$NODE_BIN" "$@"
}

require_env_files() {
  [ -f "$STABLE_ENV_DIR/api.env" ] && [ -f "$STABLE_ENV_DIR/migrate.env" ] \
    || die "the stable copy's env files are missing. Run: scripts/dev-db.sh start"
}

require_database() {
  db_ping || die "the private MariaDB is not running. Run: scripts/dev-db.sh start"
}

require_snapshot() {
  [ -f "$STABLE_ENTRY" ] || die "there is no snapshot yet. Run: scripts/stable-api.sh snapshot"
}

# Print the pid of the running copy and return 0, or return 1. A pid only counts when its
# command line is the copy's server.js.
stable_pid() {
  service_pid "$STABLE_PID_FILE" "$STABLE_ENTRY"
}

# Apply pending migrations to notchos_app with the code in the given snapshot directory.
migrate_with() {
  ( cd "$1/api" && stable_cli_node dist/cli/index.js db:migrate )
}

start_copy() {
  local pid listeners
  require_snapshot
  require_env_files
  require_database
  if pid="$(stable_pid)"; then
    echo "The stable API copy is already running (pid $pid) at $STABLE_URL"
    return 0
  fi
  listeners="$(port_listeners "$STABLE_PORT")"
  if [ -n "$listeners" ]; then
    printf '%s\n' "$listeners" >&2
    die "port $STABLE_PORT is already in use by the process above"
  fi

  migrate_with "$STABLE_CURRENT"

  pid="$(cd "$STABLE_CURRENT/api" && stable_node "$COMMON_LIB_DIR/detach.mjs" "$STABLE_LOG" "$NODE_BIN" "$STABLE_ENTRY")"
  printf '%s\n' "$pid" > "$STABLE_PID_FILE"
  wait_for_health "$STABLE_URL" "$pid" "$STABLE_LOG"
  echo "Stable API copy running at $STABLE_URL (pid $pid, database $STABLE_DATABASE)"
}

stop_copy() {
  local pid
  if ! pid="$(stable_pid)"; then
    rm -f "$STABLE_PID_FILE"
    echo "The stable API copy is not running."
    return 0
  fi
  stop_process "$pid"
  rm -f "$STABLE_PID_FILE"
  echo "Stable API copy stopped (pid $pid)."
}

print_status() {
  local pid
  if [ -f "$STABLE_CURRENT/SNAPSHOT.txt" ]; then
    sed 's/^/  /' "$STABLE_CURRENT/SNAPSHOT.txt"
  else
    echo "  no snapshot yet (scripts/stable-api.sh snapshot)"
  fi
  if ! pid="$(stable_pid)"; then
    echo "Stable API copy: not running"
    return 3
  fi
  echo "Stable API copy: running, pid $pid"
  echo "  process   $(ps -o command= -p "$pid")"
  echo "  listener  $(port_listeners "$STABLE_PORT" | tr -s ' ')"
  echo "  health    $(curl -sS --max-time 2 "$STABLE_URL/v1/health" 2>&1 || true)"
  echo "  database  $STABLE_DATABASE on $DB_HOST:$DB_PORT"
  echo "  log       $STABLE_LOG"
}

take_snapshot() {
  local stage was_running=0 migrations
  require_env_files
  require_database
  [ -d "$REPO_DIR/api/node_modules" ] || die "api/node_modules is missing. Run: (cd api && npm install)"

  echo "Building api/ ..."
  ( cd "$REPO_DIR/api" && npm run --silent build )

  # Stage next to the target, so the final move is a rename on one file system.
  private_dir "$STABLE_DIR"
  rm -rf "$STABLE_DIR"/staging.*
  stage="$STABLE_DIR/staging.$$"
  mkdir -p "$stage/api" "$stage/db/migrations"

  echo "Copying the build and the migrations ..."
  cp -R "$REPO_DIR/api/dist" "$stage/api/dist"
  cp "$REPO_DIR/api/package.json" "$REPO_DIR/api/package-lock.json" "$stage/api/"
  cp "$REPO_DIR/db/migrations/"*.sql "$stage/db/migrations/"

  echo "Installing production dependencies into the copy ..."
  ( cd "$stage/api" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline --loglevel=error ) \
    || { rm -rf "$stage"; die "npm ci failed in the staged copy; the previous snapshot is untouched"; }
  # Command shims are symlinks and nothing at runtime needs them.
  rm -rf "$stage/api/node_modules/.bin"
  if [ -n "$(find "$stage" -type l -print -quit)" ]; then
    find "$stage" -type l >&2
    rm -rf "$stage"
    die "the copy would contain symlinks (listed above)"
  fi

  migrations="$(cd "$stage/db/migrations" && shasum -a 256 -- *.sql)"
  {
    echo "snapshot taken   $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "node             $("$NODE_BIN" --version)"
    echo "api version      $("$NODE_BIN" -p "require('$stage/api/package.json').version")"
    echo "lockfile sha256  $(shasum -a 256 "$stage/api/package-lock.json" | cut -d' ' -f1)"
    echo "migrations (sha256):"
    printf '%s\n' "$migrations" | sed 's/^/  /'
  } > "$stage/SNAPSHOT.txt"

  # The staged copy must at least load: import the application and the command line, which
  # pulls in every module and every dependency, without starting anything.
  ( cd "$stage/api" && stable_cli_node --input-type=module \
      -e "await import('./dist/app.js'); await import('./dist/cli/index.js');" ) \
    || { rm -rf "$stage"; die "the staged copy does not load; the previous snapshot is untouched"; }

  if stable_pid >/dev/null; then
    was_running=1
    stop_copy
  fi

  # Migrate with the new code before it replaces the old. A refusal (for example an
  # applied migration that was edited) leaves the previous snapshot in place.
  echo "Applying migrations to $STABLE_DATABASE ..."
  if ! migrate_with "$stage"; then
    rm -rf "$stage"
    [ "$was_running" -eq 0 ] || start_copy
    die "migrations could not be applied; the previous snapshot is untouched"
  fi

  rm -rf "$STABLE_CURRENT"
  mv "$stage" "$STABLE_CURRENT"
  echo "Snapshot written to $STABLE_CURRENT"
  sed 's/^/  /' "$STABLE_CURRENT/SNAPSHOT.txt"

  if [ "$was_running" -eq 1 ]; then
    start_copy
  else
    echo "Start it with: scripts/stable-api.sh start"
  fi
}

run_cli() {
  require_snapshot
  require_env_files
  require_database
  cd "$STABLE_CURRENT/api"
  stable_cli_node dist/cli/index.js "$@"
}

case "${1:-}" in
  snapshot) take_snapshot ;;
  start) start_copy ;;
  stop) stop_copy ;;
  status) print_status ;;
  cli) shift; run_cli "$@" ;;
  *) usage ;;
esac
