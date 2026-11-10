#!/bin/bash
# The development API as a background process, for scripted checks and for other tools
# that need it running (the admin dev server proxies to it).
#
#   scripts/dev-api.sh start     run api/src on http://127.0.0.1:4310, database notchos_dev
#   scripts/dev-api.sh stop
#   scripts/dev-api.sh status    exit 0 when running, 3 when stopped
#
# This runs the sources as they are, without file watching. While editing the API, use
# `cd api && npm run dev` in a terminal instead (same port, restarts on every change).
# The process is detached from the calling shell and found again through a pid file.
# Log: ~/.notchos-dev/log/api-dev.log

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/dev-common.sh
. "$SCRIPT_DIR/lib/dev-common.sh"

REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_DIR/api"
API_ENTRY="$API_DIR/src/server.ts"
API_PID_FILE="$DB_RUN_DIR/api-dev.pid"
API_LOG="$DB_LOG_DIR/api-dev.log"
API_HOST="127.0.0.1"
API_PORT="4310"
API_DATABASE="notchos_dev"
API_URL="http://$API_HOST:$API_PORT"

usage() {
  sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

api_pid() {
  service_pid "$API_PID_FILE" "$API_ENTRY"
}

start_api() {
  local pid listeners
  [ -f "$ENV_DIR/dev.env" ] || die "the dev env file is missing. Run: scripts/dev-db.sh start"
  [ -d "$API_DIR/node_modules" ] || die "api/node_modules is missing. Run: (cd api && npm install)"
  db_ping || die "the private MariaDB is not running. Run: scripts/dev-db.sh start"
  if pid="$(api_pid)"; then
    echo "The development API is already running (pid $pid) at $API_URL"
    return 0
  fi
  listeners="$(port_listeners "$API_PORT")"
  if [ -n "$listeners" ]; then
    printf '%s\n' "$listeners" >&2
    die "port $API_PORT is already in use by the process above (npm run dev in a terminal?)"
  fi

  # A clean environment: the API reads ~/.notchos-dev/env/dev.env by itself, and host, port
  # and database are fixed here so that the calling shell cannot change them.
  pid="$(cd "$API_DIR" && env -i HOME="$HOME" PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
      NOTCHOS_ENV_FILE="$ENV_DIR/dev.env" \
      HOST="$API_HOST" PORT="$API_PORT" DB_NAME="$API_DATABASE" \
      "$NODE_BIN" "$COMMON_LIB_DIR/detach.mjs" "$API_LOG" "$NODE_BIN" "$API_ENTRY")"
  printf '%s\n' "$pid" > "$API_PID_FILE"
  wait_for_health "$API_URL" "$pid" "$API_LOG"
  echo "Development API running at $API_URL (pid $pid, database $API_DATABASE)"
}

stop_api() {
  local pid
  if ! pid="$(api_pid)"; then
    rm -f "$API_PID_FILE"
    echo "The development API (scripts/dev-api.sh) is not running."
    return 0
  fi
  stop_process "$pid"
  rm -f "$API_PID_FILE"
  echo "Development API stopped (pid $pid)."
}

print_status() {
  local pid
  if ! pid="$(api_pid)"; then
    echo "Development API: not running"
    return 3
  fi
  echo "Development API: running, pid $pid"
  echo "  process   $(ps -o command= -p "$pid")"
  echo "  listener  $(port_listeners "$API_PORT" | tr -s ' ')"
  echo "  health    $(curl -sS --max-time 2 "$API_URL/v1/health" 2>&1 || true)"
  echo "  database  $API_DATABASE on $DB_HOST:$DB_PORT"
  echo "  log       $API_LOG"
}

case "${1:-}" in
  start) start_api ;;
  stop) stop_api ;;
  status) print_status ;;
  *) usage ;;
esac
