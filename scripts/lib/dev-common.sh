# shellcheck shell=bash
# Shared paths and helpers for scripts/dev-db.sh, scripts/dev-api.sh and
# scripts/stable-api.sh. Sourced, not executed. Written for the bash 3.2 that ships with
# macOS.
#
# Everything that is private to this project lives in ~/.notchos-dev (internal disk,
# real file permissions). Nothing here ever points at /opt/homebrew/var/mysql, at
# /tmp/mysql.sock or at /opt/homebrew/etc/my.cnf: those belong to another project.

if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
  echo "error: HOME is not set" >&2
  exit 1
fi

NOTCHOS_DEV_HOME="$HOME/.notchos-dev"

# MariaDB 10.11 binaries from Homebrew. Only the binaries are used: no brew services,
# no LaunchAgent, no option file.
MARIADB_BASEDIR="/opt/homebrew/opt/mariadb@10.11"
MARIADB_BIN="$MARIADB_BASEDIR/bin"

DB_DATADIR="$NOTCHOS_DEV_HOME/mariadb"
DB_RUN_DIR="$NOTCHOS_DEV_HOME/run"
DB_LOG_DIR="$NOTCHOS_DEV_HOME/log"
DB_TMP_DIR="$NOTCHOS_DEV_HOME/tmp"
DB_SOCKET="$DB_RUN_DIR/mariadb.sock"
DB_PID_FILE="$DB_RUN_DIR/mariadb.pid"
DB_ERROR_LOG="$DB_LOG_DIR/mariadb.err"
DB_HOST="127.0.0.1"
DB_PORT="3307"

ENV_DIR="$NOTCHOS_DEV_HOME/env"
SIGNING_DIR="$NOTCHOS_DEV_HOME/signing"
SIGNING_KEY_FILE="$SIGNING_DIR/ed25519-private.pem"

STABLE_DIR="$NOTCHOS_DEV_HOME/api-stable"
STABLE_ENV_DIR="$STABLE_DIR/env"

COMMON_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() {
  echo "error: $*" >&2
  exit 1
}

# The data dir must be the private one. This can only fail if someone edits the paths above.
case "$DB_DATADIR" in
  "$HOME"/.notchos-dev/*) ;;
  *) die "refusing to run: data dir $DB_DATADIR is not inside ~/.notchos-dev" ;;
esac

# Create a private directory (mode 700) if it does not exist yet.
private_dir() {
  mkdir -p "$1"
  chmod 700 "$1"
}

# The MariaDB client as the admin of the private instance: the OS user, authenticated by
# the unix_socket plugin over the private socket. There is no admin password anywhere.
db_admin() {
  "$MARIADB_BIN/mariadb" --no-defaults --protocol=socket --socket="$DB_SOCKET" \
    --user="$(id -un)" "$@"
}

db_admin_tool() {
  "$MARIADB_BIN/mariadb-admin" --no-defaults --protocol=socket --socket="$DB_SOCKET" \
    --user="$(id -un)" "$@"
}

# True when the private server answers on its socket.
db_ping() {
  [ -S "$DB_SOCKET" ] || return 1
  db_admin_tool --connect-timeout=2 ping >/dev/null 2>&1
}

# Print the pid of the private mariadbd and return 0, or return 1 when it is not running.
# A pid only counts when its command line names the private data dir, so a recycled pid or
# any other mariadbd / mysqld on this Mac is never mistaken for ours.
db_running_pid() {
  local pid
  [ -f "$DB_PID_FILE" ] || return 1
  pid="$(tr -cd '0-9' < "$DB_PID_FILE")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -o command= -p "$pid" 2>/dev/null | grep -Fq -- "--datadir=$DB_DATADIR" || return 1
  printf '%s\n' "$pid"
}

# Print what listens on a TCP port (empty when nothing does).
port_listeners() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 || true
}

# Read KEY=value from an env file (first match, value printed as is, empty if absent).
env_value() {
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | head -n 1
}

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node is not on PATH (Node 24 is required)"

# ---- API processes started by dev-api.sh and stable-api.sh ------------------------------
# They are started through lib/detach.mjs (own session), so they survive the shell that
# started them, and are found again through a pid file.

# service_pid <pid file> <text>: print the pid and return 0 when the process named in the
# pid file is alive and its command line contains <text>; return 1 otherwise. The text
# check keeps a recycled pid from being mistaken for the service.
service_pid() {
  local pid
  [ -f "$1" ] || return 1
  pid="$(tr -cd '0-9' < "$1")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -o command= -p "$pid" 2>/dev/null | grep -Fq -- "$2" || return 1
  printf '%s\n' "$pid"
}

# wait_for_health <base url> <pid> <log file>: return 0 once GET /v1/health answers 200.
# Dies, showing the end of the log, if the process exits or 15 seconds pass.
wait_for_health() {
  local i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS -o /dev/null --max-time 2 "$1/v1/health" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$2" 2>/dev/null; then
      tail -n 20 "$3" >&2 || true
      die "the API exited during startup (log: $3)"
    fi
    sleep 0.25
    i=$((i + 1))
  done
  tail -n 20 "$3" >&2 || true
  die "the API did not answer on $1 within 15 s (log: $3)"
}

# stop_process <pid>: SIGTERM (the API shuts down cleanly), SIGKILL after 10 seconds.
stop_process() {
  local i=0
  kill -TERM "$1" 2>/dev/null || true
  while kill -0 "$1" 2>/dev/null; do
    if [ "$i" -ge 40 ]; then
      kill -KILL "$1" 2>/dev/null || true
    fi
    [ "$i" -lt 80 ] || die "process $1 does not stop"
    sleep 0.25
    i=$((i + 1))
  done
}
