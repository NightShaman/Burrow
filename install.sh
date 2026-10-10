#!/bin/sh
# Burrow user-local installer. It replaces app while preserving runtime state.
set -eu
REPOSITORY="NightShaman/Burrow"
INSTALL_DIR="${HOME}/.burrow"
SOURCE_DIR=""
INSTALL_DEPS=1
UNINSTALL=0
PURGE=0
ASSUME_YES=0
INSTALL_NODE=1
INSTALL_SERVICE=1
FRESH_INSTALL=0
LISTEN_HOST=""
LISTEN_PORT=""
RESTART_SERVICE=0
VERBOSE=0
usage() { cat <<USAGE
Usage: install.sh [options]
  --dir PATH                    installation and durable-state root
  --source-dir PATH             assembled Burrow checkout; do not download
  --no-service                  do not create a service on a fresh install
  --no-install-dependencies     skip npm ci/build (development only)
  --install-node                compatibility alias; missing Node.js 24+ is installed by default
  --host HOST                   listener host; default 127.0.0.1 on first install
  --port PORT                   listener port; default 42817 on first install
  --uninstall                   remove installed application files
  --purge                       with --uninstall, also remove all durable state
  --yes                         do not prompt for uninstall confirmation
  --verbose, -v                 show timestamped update diagnostics
  --help                        show this help
Install:   curl -fsSL https://raw.githubusercontent.com/${REPOSITORY}/main/install.sh | sh
Update:    ~/.burrow/bin/burrow update
Uninstall: ~/.burrow/bin/burrow uninstall [--purge] [--yes]
Service:   ~/.burrow/bin/burrow service {install|uninstall|start|stop|restart|status|logs}
Backup:    ~/.burrow/bin/burrow install-backup --output /safe/path/burrow.tar.gz --confirm
Restore:   ~/.burrow/bin/burrow install-restore --archive /safe/path/burrow.tar.gz --home "$HOME" --confirm
USAGE
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR=${2:?--dir requires a path}; shift 2 ;;
    --source-dir) SOURCE_DIR=${2:?--source-dir requires a path}; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --no-install-dependencies) INSTALL_DEPS=0; INSTALL_SERVICE=0; shift ;;
    --install-node) INSTALL_NODE=1; shift ;;
    --host) LISTEN_HOST=${2:?--host requires a value}; shift 2 ;;
    --port) LISTEN_PORT=${2:?--port requires a value}; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --verbose|-v) VERBOSE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Burrow install: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Shell and systemd consume generated paths. Reject unsupported encodings before
# download, mkdir, uninstall, or durable-state mutation.
case "$INSTALL_DIR" in
  /*) ;;
  *) echo "Burrow install: --dir must be absolute." >&2; exit 2 ;;
esac
case "$INSTALL_DIR" in
  *[!A-Za-z0-9_./-]*) echo "Burrow install: --dir contains unsupported characters (use letters, digits, _, ., /, -)." >&2; exit 2 ;;
esac

[ -z "$LISTEN_HOST" ] || case "$LISTEN_HOST" in
  *[!A-Za-z0-9._:-]*|'') echo "Burrow install: --host contains unsupported characters." >&2; exit 2 ;;
esac
if [ -n "$LISTEN_PORT" ]; then
  case "$LISTEN_PORT" in ''|*[!0-9]*) echo "Burrow install: --port must be an integer from 1 to 65535." >&2; exit 2 ;; esac
  [ "$LISTEN_PORT" -ge 1 ] && [ "$LISTEN_PORT" -le 65535 ] || { echo "Burrow install: --port must be an integer from 1 to 65535." >&2; exit 2; }
fi

if [ "$UNINSTALL" -eq 1 ]; then
  [ -z "$SOURCE_DIR" ] || { echo "Burrow uninstall: --source-dir is not valid with --uninstall." >&2; exit 2; }
  [ -d "$INSTALL_DIR" ] || { echo "Burrow uninstall: no installation at $INSTALL_DIR." >&2; exit 1; }
  INSTALL_DIR=$(cd "$INSTALL_DIR" && pwd)
  [ "$INSTALL_DIR" != "/" ] || { echo "Burrow uninstall: refusing to remove /." >&2; exit 1; }
  if [ "$PURGE" -eq 1 ]; then
    ACTION="remove $INSTALL_DIR, including config, workspace, cache, and reports"
  else
    ACTION="remove the application payload and launcher; durable state under $INSTALL_DIR will be preserved"
  fi
  if [ "$ASSUME_YES" -ne 1 ]; then
    if [ ! -t 0 ]; then
      echo "Burrow uninstall: refusing non-interactive uninstall without --yes." >&2
      exit 2
    fi
    printf "Burrow uninstall will %s. Continue? [y/N] " "$ACTION"
    read -r answer || answer=""
    case "$answer" in y|Y|yes|YES) ;; *) echo "Burrow uninstall: cancelled."; exit 0 ;; esac
  fi
  SERVICE_UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/burrow.service"
  if [ -f "$SERVICE_UNIT" ] && grep -Fxq "ExecStart=$INSTALL_DIR/bin/burrow serve" "$SERVICE_UNIT" && command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now burrow.service >/dev/null 2>&1 || true
    rm -f "$SERVICE_UNIT"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  if [ "$PURGE" -eq 1 ]; then
    rm -rf "$INSTALL_DIR"
    printf "%s\n" "Burrow uninstall: removed $INSTALL_DIR"
  else
    rm -rf "$INSTALL_DIR/app" "$INSTALL_DIR/.app-staging-"* "$INSTALL_DIR/.app-previous" "$INSTALL_DIR/bin/burrow"
    rmdir "$INSTALL_DIR/bin" 2>/dev/null || true
    printf "%s\n" "Burrow uninstall: application removed" "Preserved: $INSTALL_DIR/{config,workspace,cache,reports,integrations,burrow.env}"
  fi
  exit 0
fi

TMP_ROOT=""
PG_KEY_TMP=""
STAGING=""
LOCK_DIR=""
update_log() { printf '%s\n' "Burrow update: $*"; }
verbose_log() {
  [ "$VERBOSE" -eq 1 ] || return 0
  printf '%s %s\n' "Burrow update [$(date -u +%Y-%m-%dT%H:%M:%SZ)]" "$*"
}
cleanup() {
  status=$?
  [ -z "$STAGING" ] || rm -rf "$STAGING"
  [ -z "$LOCK_DIR" ] || rm -rf "$LOCK_DIR"
  [ -z "$TMP_ROOT" ] || rm -rf "$TMP_ROOT"
  [ -z "$PG_KEY_TMP" ] || rm -f "$PG_KEY_TMP"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

node_is_supported() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || return 1
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
  [ -n "$node_major" ] && [ "$node_major" -ge 24 ]
}

install_node_24_ubuntu() {
  command -v apt-get >/dev/null 2>&1 || { echo "Burrow install: apt-get is required to install Node.js on Ubuntu." >&2; exit 1; }
  echo "Burrow install: installing Node.js 24 LTS from the NodeSource APT repository..."
  $SUDO apt-get update
  $SUDO apt-get install -y ca-certificates curl gnupg
  $SUDO install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  $SUDO apt-get update
  $SUDO apt-get install -y nodejs
}

install_node_24_rhel() {
  command -v dnf >/dev/null 2>&1 || { echo "Burrow install: dnf is required to install Node.js on RHEL-family Linux." >&2; exit 1; }
  echo "Burrow install: installing Node.js 24 LTS from the NodeSource RPM repository..."
  $SUDO dnf install -y ca-certificates curl
  curl -fsSL https://rpm.nodesource.com/setup_24.x | $SUDO bash -
  $SUDO dnf install -y nodejs
}

install_node_24() {
  [ -r /etc/os-release ] || { echo "Burrow install: automatic Node.js installation is supported on Ubuntu and RHEL-family Linux only." >&2; exit 1; }
  . /etc/os-release
  if [ "${ID:-}" = "ubuntu" ]; then
    DISTRO=ubuntu
  elif [ "${ID:-}" = "rhel" ] || [ "${ID:-}" = "rocky" ] || [ "${ID:-}" = "almalinux" ] || [ "${ID:-}" = "centos" ]; then
    RHEL_MAJOR=${VERSION_ID%%.*}
    case "$RHEL_MAJOR" in
      ''|*[!0-9]*) echo "Burrow install: could not determine the RHEL-family major version." >&2; exit 1 ;;
    esac
    [ "$RHEL_MAJOR" -ge 9 ] || { echo "Burrow install: automatic Node.js installation requires RHEL-family Linux 9 or newer." >&2; exit 1; }
    DISTRO=rhel
  else
    echo "Burrow install: automatic Node.js installation is supported on Ubuntu and RHEL-family Linux only." >&2
    exit 1
  fi
  if [ "$(id -u)" -eq 0 ]; then SUDO="";
  elif command -v sudo >/dev/null 2>&1; then SUDO="sudo";
  else echo "Burrow install: sudo is required to install Node.js 24 LTS." >&2; exit 1; fi
  case "$DISTRO" in
    ubuntu) install_node_24_ubuntu ;;
    rhel) install_node_24_rhel ;;
  esac
}

ensure_node_24() {
  node_is_supported && return 0
  install_node_24
  node_is_supported || { echo "Burrow install: Node.js 24+ installation did not produce a supported node/npm runtime." >&2; exit 1; }
}

# `burrow update` replaces the running app payload. Restart a managed user
# service only after activation. An SSH/non-login shell may lack
# XDG_RUNTIME_DIR even while the user's systemd manager is healthy.
user_systemctl() {
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user "$@"
  else
    systemctl --user "$@"
  fi
}

prepare_service_restart() {
  [ -d "$INSTALL_DIR/app" ] || return 0
  SERVICE_UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/burrow.service"
  [ -f "$SERVICE_UNIT" ] || return 0
  grep -Fxq "ExecStart=$INSTALL_DIR/bin/burrow serve" "$SERVICE_UNIT" || { echo "Burrow update: burrow.service belongs to another installation; refusing to restart it." >&2; exit 1; }
  command -v systemctl >/dev/null 2>&1 || { echo "Burrow update: a Burrow user service exists but systemctl is unavailable; refusing an update that cannot restart it." >&2; exit 1; }
  user_systemctl show-environment >/dev/null 2>&1 || { echo "Burrow update: could not reach the Burrow user-service manager; refusing an update that cannot restart it." >&2; exit 1; }
  # Preserve stopped/disabled service policy: update files without starting it.
  if user_systemctl is-active --quiet burrow.service; then RESTART_SERVICE=1; fi
  verbose_log "managed service detected: $SERVICE_UNIT"
}

runtime_endpoint() {
  host=$(grep '^BURROW_UI_HOST=' "$ENV_FILE" | cut -d= -f2- || true)
  port=$(grep '^BURROW_UI_PORT=' "$ENV_FILE" | cut -d= -f2- || true)
  host=${host:-127.0.0.1}
  port=${port:-42817}
  [ "$host" = "0.0.0.0" ] && host=127.0.0.1
  [ "$host" = "::" ] && host=::1
  case "$host" in *:*) host="[$host]" ;; esac
}

verify_restarted_runtime() {
  # GitHub assemblies write their immutable build identity into SOURCE_VERSIONS.
  # Development/source-dir installs retain package-version fallback support.
  expected_version=$(awk '$1 == "Burrow-Build-Version" { print $2; exit }' "$INSTALL_DIR/app/SOURCE_VERSIONS" 2>/dev/null || true)
  [ -n "$expected_version" ] || expected_version=$(node -e 'process.stdout.write(String(require(process.argv[1]).version))' "$INSTALL_DIR/app/backend/package.json")
  runtime_endpoint
  previous_invocation=${1:-}
  verbose_log "waiting for new service invocation after ${previous_invocation:-none}; expected build $expected_version"
  last_unit_state=unknown
  last_health=unreachable
  health_version=""
  # Database migrations can legitimately outlast a short HTTP-start deadline.
  readiness_seconds=${BURROW_INSTALL_READINESS_SECONDS:-${BURROW_UPDATE_READINESS_SECONDS:-1800}}
  case "$readiness_seconds" in ''|*[!0-9]*|0) echo "Burrow readiness timeout must be a positive integer" >&2; exit 1 ;; esac
  for attempt in $(seq 1 "$readiness_seconds"); do
    last_unit_state=$(user_systemctl is-active burrow.service 2>/dev/null || true)
    current_invocation=$(user_systemctl show burrow.service -p InvocationID --value 2>/dev/null || true)
    if [ "$last_unit_state" = active ] && { [ -z "$previous_invocation" ] || [ "$current_invocation" != "$previous_invocation" ]; }; then
      last_health=$(curl -fsS --noproxy '*' --max-time 2 "http://$host:$port/api/health" 2>/dev/null || true)
      health_version=$(printf '%s' "$last_health" | node -e 'let body=""; process.stdin.on("data", chunk => { body += chunk; }).on("end", () => { try { process.stdout.write(String(JSON.parse(body).ok === true && JSON.parse(body).runtime === "burrow" ? JSON.parse(body).version || "" : "")); } catch {} });')
      verbose_log "start check $attempt/$readiness_seconds: invocation=${current_invocation:-unknown}; health_version=${health_version:-none}"
      [ "$health_version" = "$expected_version" ] && { verbose_log "service healthy on build $health_version"; return 0; }
    fi
    case "$last_unit_state" in failed|inactive) break ;; esac
    if [ "$attempt" -eq 1 ] || [ "$((attempt % 30))" -eq 0 ]; then
      printf '%s\n' "Burrow install: waiting for HTTP readiness (database initialization/migrations may take time)..."
    fi
    sleep 1
  done
  if [ "$last_unit_state" != active ]; then
    echo "Burrow update: burrow.service is $last_unit_state after start; expected a new service invocation within $readiness_seconds seconds." >&2
  elif [ -n "$previous_invocation" ] && [ "$current_invocation" = "$previous_invocation" ]; then
    echo "Burrow update: burrow.service remained on invocation $current_invocation after start; expected a new runtime." >&2
  elif [ -n "$health_version" ]; then
    echo "Burrow update: new service invocation $current_invocation is active but health reported version $health_version, expected $expected_version within $readiness_seconds seconds." >&2
  else
    echo "Burrow update: new service invocation $current_invocation is active but health at http://$host:$port/api/health was unreachable within $readiness_seconds seconds." >&2
  fi
  user_systemctl status burrow.service --no-pager -n 20 >&2 || true
  exit 1
}

if [ -z "$SOURCE_DIR" ]; then
  command -v curl >/dev/null 2>&1 || { echo "Burrow install: curl is required." >&2; exit 1; }
  TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/burrow-install.XXXXXX")
  verbose_log "created temporary staging root"
  # Resolve main through GitHub's commit API, then download that immutable
  # codeload archive. `archive/refs/heads/main` is CDN-cached and can lag a
  # completed assembly by minutes, leaving an update to reinstall stale code.
  assembly_sha=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${REPOSITORY}/commits/main" | sed -n 's/^[[:space:]]*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]*\)".*/\1/p' | head -n 1)
  [ "${#assembly_sha}" -eq 40 ] || { echo "Burrow install: could not resolve the current GitHub assembly commit." >&2; exit 1; }
  update_log "downloading assembly $assembly_sha"
  verbose_log "resolved immutable GitHub assembly commit $assembly_sha"
  verbose_log "downloading immutable assembly archive from codeload.github.com"
  curl -fsSL "https://codeload.github.com/${REPOSITORY}/tar.gz/$assembly_sha" -o "$TMP_ROOT/burrow.tar.gz"
  tar -xzf "$TMP_ROOT/burrow.tar.gz" -C "$TMP_ROOT"
  SOURCE_DIR=$(find "$TMP_ROOT" -mindepth 1 -maxdepth 1 -type d -name "Burrow-*" | head -n 1)
  [ -n "$SOURCE_DIR" ] && [ -x "$SOURCE_DIR/install.sh" ] || { echo "Burrow install: downloaded assembly has no executable installer." >&2; exit 1; }

  # The installed launcher enters the installer from the previous release. Hand
  # control to the downloaded release before applying migrations so an update
  # uses the installer semantics shipped with the payload it is activating.
  # Without this handoff, every installer migration takes effect one update late.
  set -- --source-dir "$SOURCE_DIR" --dir "$INSTALL_DIR"
  [ "$INSTALL_SERVICE" -ne 0 ] || set -- "$@" --no-service
  [ "$INSTALL_DEPS" -ne 0 ] || set -- "$@" --no-install-dependencies
  [ "$INSTALL_NODE" -ne 1 ] || set -- "$@" --install-node
  [ -z "$LISTEN_HOST" ] || set -- "$@" --host "$LISTEN_HOST"
  [ -z "$LISTEN_PORT" ] || set -- "$@" --port "$LISTEN_PORT"
  [ "$VERBOSE" -ne 1 ] || set -- "$@" --verbose
  verbose_log "handing update to incoming assembly installer"
  # Keep download ownership in this process on both success and failure.
  "$SOURCE_DIR/install.sh" "$@"
  exit $?
fi
[ -n "$SOURCE_DIR" ] && [ -f "$SOURCE_DIR/backend/package.json" ] && [ -f "$SOURCE_DIR/ui/package.json" ] || { echo "Burrow install: source is not an assembled Burrow checkout: ${SOURCE_DIR:-unknown}" >&2; exit 1; }
INSTALL_DIR=$(mkdir -p "$INSTALL_DIR" && cd "$INSTALL_DIR" && pwd)
# Fresh installation opts into persistence; updates never change service policy.
[ -d "$INSTALL_DIR/app" ] && [ ! -f "$INSTALL_DIR/.service-install-pending" ] || FRESH_INSTALL=1
if [ "$FRESH_INSTALL" -eq 1 ] && [ "$INSTALL_SERVICE" -eq 1 ]; then
  command -v systemctl >/dev/null 2>&1 && command -v loginctl >/dev/null 2>&1 || { echo "Burrow install: persistent installation requires systemd and loginctl; use --no-service for an operator-managed supervisor." >&2; exit 1; }
  SERVICE_UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/burrow.service"
  [ ! -f "$SERVICE_UNIT" ] || { [ -f "$INSTALL_DIR/.service-install-pending" ] && grep -Fxq "ExecStart=$INSTALL_DIR/bin/burrow serve" "$SERVICE_UNIT"; } || { echo "Burrow install: an existing burrow.service may belong to another root; refusing to replace it. Use --no-service or uninstall that service first." >&2; exit 1; }
fi
# Atomic per-root lock; never steal a possibly live updater's lock. A stale
# owner requires explicit operator recovery rather than unsafe PID reuse guesses.
if mkdir "$INSTALL_DIR/.install-lock" 2>/dev/null; then
  LOCK_DIR="$INSTALL_DIR/.install-lock"
  printf '%s\n' "$$" > "$LOCK_DIR/owner"
else
  owner=$(cat "$INSTALL_DIR/.install-lock/owner" 2>/dev/null || true)
  echo "Burrow install: update in progress (owner ${owner:-unknown}); inspect .install-lock before retrying." >&2
  exit 1
fi

if [ -n "${BURROW_INSTALL_TEST_ROOT:-}" ]; then
  TEST_ROOT=$(cd "$BURROW_INSTALL_TEST_ROOT" && pwd) || { echo "Burrow install: test root is unavailable." >&2; exit 1; }
  TEST_HOME=$(cd "$HOME" && pwd) || { echo "Burrow install: test HOME is unavailable." >&2; exit 1; }
  TEST_CONFIG=$(mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}" && cd "${XDG_CONFIG_HOME:-$HOME/.config}" && pwd)
  TEST_TMP=$(mkdir -p "${TMPDIR:-/tmp}" && cd "${TMPDIR:-/tmp}" && pwd)
  for TEST_PATH in "$INSTALL_DIR" "$TEST_HOME" "$TEST_CONFIG" "$TEST_TMP"; do
    case "$TEST_PATH" in "$TEST_ROOT"|"$TEST_ROOT"/*) ;; *) echo "Burrow install: test isolation requires install, home, config, and temp paths beneath BURROW_INSTALL_TEST_ROOT." >&2; exit 1 ;; esac
  done
  case "${XDG_RUNTIME_DIR:-}" in "$TEST_ROOT"|"$TEST_ROOT"/*) ;; *) echo "Burrow install: test isolation requires XDG_RUNTIME_DIR beneath BURROW_INSTALL_TEST_ROOT." >&2; exit 1 ;; esac
fi
# Install host packages only for the default managed binary layout. Custom binary
# paths are operator-owned; an APT install cannot satisfy them reliably.
install_managed_postgres_ubuntu() {
  [ -r /etc/os-release ] || { echo "Burrow install: automatic PostgreSQL installation requires Ubuntu; install PostgreSQL 17 and pgvector manually for this host." >&2; exit 1; }
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || { echo "Burrow install: automatic PostgreSQL installation requires Ubuntu; install PostgreSQL 17 and pgvector manually for this host." >&2; exit 1; }
  command -v apt-get >/dev/null 2>&1 || { echo "Burrow install: apt-get is required to install PostgreSQL." >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || { echo "Burrow install: curl is required to configure the PostgreSQL APT repository." >&2; exit 1; }
  if [ "$(id -u)" -eq 0 ]; then SUDO="";
  elif command -v sudo >/dev/null 2>&1; then SUDO=sudo;
  else echo "Burrow install: sudo is required to install managed PostgreSQL packages." >&2; exit 1; fi
  case "${VERSION_CODENAME:-}" in
    ''|*[!a-z0-9]*) echo "Burrow install: unsupported Ubuntu codename for PostgreSQL APT repository." >&2; exit 1 ;;
  esac
  echo "Burrow install: installing PostgreSQL 17 and pgvector from PGDG for Ubuntu ${VERSION_CODENAME}..."
  $SUDO apt-get update
  $SUDO apt-get install -y ca-certificates curl gnupg
  $SUDO install -d -m 0755 /etc/apt/keyrings
  # Keyring and source changes are idempotent across updates.
  PG_KEY_TMP=$(mktemp "${TMPDIR:-/tmp}/burrow-pgdg-key.XXXXXX")
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$PG_KEY_TMP"
  $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/postgresql.gpg "$PG_KEY_TMP"
  rm -f "$PG_KEY_TMP"; PG_KEY_TMP=""
  printf '%s\n' "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" | $SUDO tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  $SUDO apt-get update
  $SUDO apt-get install -y postgresql-17 postgresql-client-17 postgresql-17-pgvector
}

# Native installs use the same PostgreSQL supervisor as the Docker entrypoint.
# Resolve database mode before touching durable configuration or activating an app.
ENV_FILE="$INSTALL_DIR/burrow.env"
env_setting() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1; }
postgres_mode=$(env_setting BURROW_POSTGRES_LIFECYCLE)
[ -n "$postgres_mode" ] || postgres_mode=$(env_setting BURROW_POSTGRES_MODE)
if [ -z "$postgres_mode" ]; then
  if [ -n "$(env_setting BURROW_POSTGRES_URL)" ] || [ -n "$(env_setting DATABASE_URL)" ]; then
    postgres_mode=external
  else
    postgres_mode=managed
  fi
fi
case "$postgres_mode" in
  managed)
    [ "$(id -u)" -ne 0 ] || { echo "Burrow install: managed PostgreSQL cannot run as root; install as the Burrow service user." >&2; exit 1; }
    pg_bin_dir=$(env_setting BURROW_POSTGRES_BIN_DIR)
    [ -n "$pg_bin_dir" ] || pg_bin_dir=/usr/lib/postgresql/17/bin
    pg_initdb=$(env_setting BURROW_POSTGRES_INITDB)
    pg_ctl=$(env_setting BURROW_POSTGRES_PG_CTL)
    pg_server=$(env_setting BURROW_POSTGRES_BIN)
    [ -n "$pg_initdb" ] || pg_initdb="$pg_bin_dir/initdb"
    [ -n "$pg_ctl" ] || pg_ctl="$pg_bin_dir/pg_ctl"
    [ -n "$pg_server" ] || pg_server="$pg_bin_dir/postgres"
    # The installer writes these default paths to burrow.env, so updates must
    # recognize the resolved paths, not merely the absence of overrides.
    pg_config="$(dirname "$pg_server")/pg_config"
    if [ "$pg_bin_dir" = /usr/lib/postgresql/17/bin ] && [ "$pg_initdb" = /usr/lib/postgresql/17/bin/initdb ] && [ "$pg_ctl" = /usr/lib/postgresql/17/bin/pg_ctl ] && [ "$pg_server" = /usr/lib/postgresql/17/bin/postgres ] && [ -z "${BURROW_INSTALL_TEST_ROOT:-}" ]; then
      pg_missing=0
      for pg_exe in "$pg_initdb" "$pg_ctl" "$pg_server"; do [ -x "$pg_exe" ] || pg_missing=1; done
      [ -f /usr/share/postgresql/17/extension/vector.control ] || pg_missing=1
      if [ "$pg_missing" -eq 1 ]; then
        install_managed_postgres_ubuntu
      fi
    fi
    for pg_exe in "$pg_initdb" "$pg_ctl" "$pg_server"; do
      [ -x "$pg_exe" ] || { echo "Burrow install: managed PostgreSQL 17 requires $pg_exe. Install PostgreSQL 17 and pgvector for PostgreSQL 17, or configure BURROW_POSTGRES_LIFECYCLE=external with BURROW_POSTGRES_URL in $ENV_FILE." >&2; exit 1; }
    done
    pg_major=$("$pg_server" --version | sed -n 's/.*PostgreSQL) \([0-9][0-9]*\).*/\1/p')
    [ "$pg_major" = 17 ] || { echo "Burrow install: managed PostgreSQL server must be major 17." >&2; exit 1; }
    [ -x "$pg_config" ] || [ "$pg_bin_dir" = /usr/lib/postgresql/17/bin ] || { echo "Burrow install: managed PostgreSQL 17 requires $pg_config to locate its pgvector extension." >&2; exit 1; }
    if [ "$pg_bin_dir" = /usr/lib/postgresql/17/bin ]; then pg_sharedir=/usr/share/postgresql/17
    else pg_sharedir=$("$pg_config" --sharedir); fi
    if [ ! -f "$pg_sharedir/extension/vector.control" ]; then
      echo "Burrow install: managed PostgreSQL 17 requires its pgvector extension (postgresql-17-pgvector on Ubuntu)." >&2; exit 1
    fi
    ;;
  external)
    if [ -z "$(env_setting BURROW_POSTGRES_URL)" ] && [ -z "$(env_setting DATABASE_URL)" ] && [ -z "$(env_setting BURROW_POSTGRES_HOST)" ]; then
      echo "Burrow install: external PostgreSQL requires BURROW_POSTGRES_URL or BURROW_POSTGRES_HOST in $ENV_FILE." >&2; exit 1
    fi
    ;;
  *) echo "Burrow install: PostgreSQL lifecycle $postgres_mode is not supported for a PostgreSQL-only runtime. Set managed or external in $ENV_FILE." >&2; exit 1 ;;
esac
prepare_service_restart
verbose_log "install root prepared; source mode=${SOURCE_DIR:+assembled}"
# An update is entered through the absolute launcher, but package lifecycle
# scripts may invoke `burrow`. Keep the active installation launcher visible
# throughout staging rather than depending on a login-shell PATH.
case ":$PATH:" in
  *":$INSTALL_DIR/bin:"*) ;;
  *) PATH="$INSTALL_DIR/bin:$PATH"; export PATH ;;
esac
mkdir -p "$INSTALL_DIR/config" "$INSTALL_DIR/workspace" "$INSTALL_DIR/cache" "$INSTALL_DIR/reports" "$INSTALL_DIR/integrations" "$INSTALL_DIR/bin"
STAGING="$INSTALL_DIR/.app-staging-$$"
verbose_log "staging application payload"
PREVIOUS="$INSTALL_DIR/.app-previous-$$"
rm -rf "$STAGING" "$PREVIOUS"; mkdir -p "$STAGING"
cp -R "$SOURCE_DIR/backend" "$STAGING/backend"
cp "$SOURCE_DIR/install.sh" "$STAGING/install.sh"
[ -f "$SOURCE_DIR/SOURCE_VERSIONS" ] && cp "$SOURCE_DIR/SOURCE_VERSIONS" "$STAGING/SOURCE_VERSIONS" || true
chmod 0755 "$STAGING/install.sh"
[ "$INSTALL_DEPS" -ne 1 ] || ensure_node_24
cp -R "$SOURCE_DIR/ui" "$STAGING/ui"
# GitHub assemblies contain a prebuilt UI. Updating from one must activate
# those immutable assets, not reinstall 129 packages and rebuild Vite on the
# live host. Source-directory installs retain the build fallback.
if [ -d "$SOURCE_DIR/ui/dist" ]; then
  verbose_log "using prebuilt UI assets from assembly"
  mkdir -p "$STAGING/backend/public/ui"
  cp -R "$SOURCE_DIR/ui/dist/." "$STAGING/backend/public/ui/"
elif [ "$INSTALL_DEPS" -eq 1 ]; then
  verbose_log "building UI because source has no prebuilt assets"
  (cd "$STAGING/ui" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent)
  mkdir -p "$STAGING/backend/public/ui"; cp -R "$STAGING/ui/dist/." "$STAGING/backend/public/ui/"
fi
if [ "$INSTALL_DEPS" -eq 1 ]; then
  # These are runtime-owned integrations, not application dependencies. Stage
  # them before activation so a failed install cannot leave a partial runtime.
  mkdir -p "$STAGING/integrations/mcporter" "$STAGING/integrations/claude-code"
  update_log "staging backend runtime dependencies..."
  verbose_log "running backend npm ci (production dependencies only)"
  (cd "$STAGING/backend" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  INTEGRATION_MANIFEST="$STAGING/backend/scripts/runtime-integrations.json"
  MCPORTER_VERSION=$(node -e 'process.stdout.write(require(process.argv[1])["mcporter"].version)' "$INTEGRATION_MANIFEST")
  CLAUDE_CODE_VERSION=$(node -e 'process.stdout.write(require(process.argv[1])["claude-code"].version)' "$INTEGRATION_MANIFEST")
  update_log "staging MCP integration..."
  verbose_log "installing pinned mcporter integration $MCPORTER_VERSION"
  npm install --prefix "$STAGING/integrations/mcporter" --omit=dev --no-package-lock --no-save --no-audit --no-fund --loglevel=error "mcporter@$MCPORTER_VERSION"
  update_log "staging Claude Code integration..."
  verbose_log "installing Claude Code integration $CLAUDE_CODE_VERSION; no executable probe will run"
  cat > "$STAGING/integrations/claude-code/package.json" <<PACKAGE
{
  "private": true,
  "dependencies": { "@anthropic-ai/claude-code": "$CLAUDE_CODE_VERSION" },
  "allowScripts": { "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION": true }
}
PACKAGE
  npm install --prefix "$STAGING/integrations/claude-code" --omit=dev --no-package-lock --ignore-scripts=false --no-audit --no-fund --loglevel=error
  # Installing the requested package is sufficient update-time validation. Running
  # `claude --version` can initialize external/runtime state and hang despite a
  # successful install, needlessly blocking activation of an otherwise valid
  # Burrow payload. The runtime invokes Claude only when that integration is
  # actually used.
fi
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<ENV
# Durable Burrow runtime state. Installer-managed paths are reconciled on update;
# operator-owned and unknown settings are preserved.
BURROW_RUNTIME_ROOT=$INSTALL_DIR
BURROW_WORKSPACE_ROOT=$INSTALL_DIR/workspace
BURROW_CACHE_ROOT=$INSTALL_DIR/cache
BURROW_CLAUDE_BIN=$INSTALL_DIR/integrations/claude-code/node_modules/.bin/claude
# 32-byte AES-256 key for encrypted model/provider settings. Keep this file private.
BURROW_SETTINGS_KEY=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')
BURROW_UI_HOST=127.0.0.1
BURROW_UI_PORT=42817
ENV
fi

set_env_value() {
  env_key=$1
  env_value=$2
  env_tmp="$ENV_FILE.tmp.$$"
  awk -v key="$env_key" -v value="$env_value" '
    BEGIN { replaced=0 }
    index($0, key "=") == 1 { if (!replaced) print key "=" value; replaced=1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$ENV_FILE" > "$env_tmp"
  chmod 0600 "$env_tmp"
  mv "$env_tmp" "$ENV_FILE"
}

# These locations are owned by the installer and follow the active installation
# root. Reconcile them on every update so old installs and restored installs gain
# newly required runtime paths without replacing operator-owned settings.
set_env_value BURROW_RUNTIME_ROOT "$INSTALL_DIR"
set_env_value BURROW_WORKSPACE_ROOT "$INSTALL_DIR/workspace"
set_env_value BURROW_CACHE_ROOT "$INSTALL_DIR/cache"
set_env_value BURROW_CLAUDE_BIN "$INSTALL_DIR/integrations/claude-code/node_modules/.bin/claude"
if ! grep -q '^BURROW_SETTINGS_KEY=' "$ENV_FILE"; then
  set_env_value BURROW_SETTINGS_KEY "$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')"
fi
# Existing operator database settings are preserved. Old installations without
# a mode now receive managed PostgreSQL (or external when a URL is configured).
if [ -z "$(env_setting BURROW_POSTGRES_LIFECYCLE)" ] && [ -z "$(env_setting BURROW_POSTGRES_MODE)" ]; then
  set_env_value BURROW_POSTGRES_LIFECYCLE "$postgres_mode"
fi
if [ "$postgres_mode" = managed ]; then
  set_env_value BURROW_POSTGRES_INITDB "$pg_initdb"
  set_env_value BURROW_POSTGRES_PG_CTL "$pg_ctl"
  set_env_value BURROW_POSTGRES_BIN "$pg_server"
fi
# Listener values are durable by default. Explicit installer flags are the
# supported deployment-management interface for changing them on install or update.
[ -z "$LISTEN_HOST" ] || set_env_value BURROW_UI_HOST "$LISTEN_HOST"
[ -z "$LISTEN_PORT" ] || set_env_value BURROW_UI_PORT "$LISTEN_PORT"
# Prepare and atomically activate the replacement while the current service remains
# available. Renames are metadata operations on this filesystem; the only
# intended downtime is systemd's own restart after activation. Do not manually
# stop/start around these swaps: that created an opaque failure window and left
# a healthy runtime down when activation stalled.
WRAPPER_TMP="$INSTALL_DIR/bin/.burrow-launcher-$$"
rm -f "$WRAPPER_TMP"
# The launcher is self-locating and must be emitted literally. An unquoted
# heredoc executes command substitutions while writing it; that can launch a
# child `burrow serve` during update and wedge the restart.
cat > "$WRAPPER_TMP" <<'WRAPPER'
#!/bin/sh
set -eu
BURROW_HOME="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
[ ! -f "$BURROW_HOME/burrow.env" ] || { set -a; . "$BURROW_HOME/burrow.env"; set +a; }
# The launcher location is authoritative after a portable restore; never let a
# copied burrow.env redirect the active installation back to its former home.
export BURROW_RUNTIME_ROOT="$BURROW_HOME"
case "${1:-}" in
  update) shift; exec "$BURROW_HOME/app/install.sh" --dir "$BURROW_HOME" "$@" ;;
  uninstall) shift; exec "$BURROW_HOME/app/install.sh" --dir "$BURROW_HOME" --uninstall "$@" ;;
  service)
    shift
    SERVICE_ACTION="${1:-status}"
    SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    SERVICE_UNIT="$SERVICE_DIR/burrow.service"
    if [ -f "$SERVICE_UNIT" ] && ! grep -Fxq "ExecStart=$BURROW_HOME/bin/burrow serve" "$SERVICE_UNIT"; then
      echo "Burrow service: existing burrow.service belongs to another installation; refusing to change it." >&2
      exit 1
    fi
    command -v systemctl >/dev/null 2>&1 || { echo "Burrow service: systemd user services are unavailable." >&2; exit 1; }
    user_systemctl() {
      if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
        XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user "$@"
      else
        systemctl --user "$@"
      fi
    }
    case "$SERVICE_ACTION" in
      install)
        # A service install promises persistence across logout and reboot.
        # `burrow serve` remains the explicit session-only option.
        command -v loginctl >/dev/null 2>&1 || { echo "Burrow service: loginctl is required to enable persistent user services; use 'burrow serve' for a session-only runtime." >&2; exit 1; }
        SERVICE_USER="$(id -un)"
        if [ "$(loginctl show-user "$SERVICE_USER" -p Linger --value 2>/dev/null || true)" != yes ]; then
          if ! loginctl enable-linger "$SERVICE_USER" >/dev/null 2>&1; then
            command -v sudo >/dev/null 2>&1 && sudo loginctl enable-linger "$SERVICE_USER" || { echo "Burrow service: enabling lingering requires permission (or sudo)." >&2; exit 1; }
          fi
        fi
        if [ "$(loginctl show-user "$SERVICE_USER" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
          echo "Burrow service: could not enable lingering for $SERVICE_USER; service installation requires lingering to persist after logout and reboot. Use 'burrow serve' for a session-only runtime." >&2
          exit 1
        fi
        user_systemctl show-environment >/dev/null 2>&1 || { echo "Burrow service: cannot reach the systemd user manager after enabling lingering; log in as $SERVICE_USER and retry." >&2; exit 1; }
        mkdir -p "$SERVICE_DIR"
        # systemd user services do not inherit the login shell PATH. Preserve
        # the current baseline and include npm's user-global bin directory so
        # MCPs that legitimately invoke user-installed CLIs work normally.
        SERVICE_PATH="$PATH"
        NPM_GLOBAL_PREFIX="$(npm prefix -g 2>/dev/null || true)"
        NPM_GLOBAL_BIN="${NPM_GLOBAL_PREFIX:+$NPM_GLOBAL_PREFIX/bin}"
        if [ -n "$NPM_GLOBAL_BIN" ] && [ -d "$NPM_GLOBAL_BIN" ]; then
          case ":$SERVICE_PATH:" in
            *":$NPM_GLOBAL_BIN:"*) ;;
            *) SERVICE_PATH="$NPM_GLOBAL_BIN:$SERVICE_PATH" ;;
          esac
        fi
        cat > "$SERVICE_UNIT" <<UNIT
[Unit]
Description=Burrow runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="PATH=$SERVICE_PATH"
EnvironmentFile=$BURROW_HOME/burrow.env
ExecStart=$BURROW_HOME/bin/burrow serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
        user_systemctl daemon-reload
        user_systemctl enable --now burrow.service
        echo "Burrow service: enabled and startup requested; persistent for $SERVICE_USER."
        ;;
      uninstall)
        user_systemctl disable --now burrow.service || true
        rm -f "$SERVICE_UNIT"
        user_systemctl daemon-reload
        echo "Burrow service: removed."
        ;;
      start|stop|restart|status) user_systemctl "$SERVICE_ACTION" burrow.service ;;
      logs) shift; exec journalctl --user-unit burrow.service --no-pager "$@" ;;
      *) echo "Usage: burrow service {install|uninstall|start|stop|restart|status|logs}" >&2; exit 2 ;;
    esac
    ;;
  serve)
    shift
    exec node "$BURROW_HOME/app/backend/scripts/postgres-supervisor.mjs" node "$BURROW_HOME/app/backend/bin/burrow.mjs" serve --root "$BURROW_HOME/app/backend" "$@"
    ;;
  install-backup) shift; exec node "$BURROW_HOME/app/backend/bin/burrow.mjs" install-backup --root "$BURROW_HOME" "$@" ;;
  install-restore) shift; exec node "$BURROW_HOME/app/backend/bin/burrow.mjs" install-restore "$@" ;;
  *) exec node "$BURROW_HOME/app/backend/bin/burrow.mjs" "$@" --root "$BURROW_HOME/app/backend" ;;
esac
WRAPPER
chmod 0755 "$WRAPPER_TMP"
# Capture the live service invocation before activation. `restart` must create
# a different invocation; otherwise the update did not actually replace the
# running runtime.
previous_invocation=""
if [ "$RESTART_SERVICE" -eq 1 ]; then
  previous_invocation=$(user_systemctl show burrow.service -p InvocationID --value 2>/dev/null || true)
  verbose_log "captured managed service invocation ${previous_invocation:-unknown} before atomic activation"
fi
if [ "$FRESH_INSTALL" -eq 1 ] && [ "$INSTALL_SERVICE" -eq 1 ]; then
  touch "$INSTALL_DIR/.service-install-pending"
fi
mv -f "$WRAPPER_TMP" "$INSTALL_DIR/bin/burrow"
[ ! -d "$INSTALL_DIR/app" ] || mv "$INSTALL_DIR/app" "$PREVIOUS"
if ! mv "$STAGING" "$INSTALL_DIR/app"; then [ ! -d "$PREVIOUS" ] || mv "$PREVIOUS" "$INSTALL_DIR/app"; echo "Burrow install: could not activate new app payload." >&2; exit 1; fi
if [ "$INSTALL_DEPS" -eq 1 ]; then
  mkdir -p "$PREVIOUS/integrations"
  for integration in mcporter claude-code; do
    [ ! -d "$INSTALL_DIR/integrations/$integration" ] || mv "$INSTALL_DIR/integrations/$integration" "$PREVIOUS/integrations/$integration"
    mv "$INSTALL_DIR/app/integrations/$integration" "$INSTALL_DIR/integrations/$integration"
  done
  rmdir "$INSTALL_DIR/app/integrations" 2>/dev/null || true
fi
if [ "$RESTART_SERVICE" -eq 1 ]; then
  update_log "restarting managed service..."
  verbose_log "restarting burrow.service after atomic payload activation"
  user_systemctl restart burrow.service
  verify_restarted_runtime "$previous_invocation"
elif [ "$FRESH_INSTALL" -eq 1 ] && [ "$INSTALL_SERVICE" -eq 1 ]; then
  update_log "installing persistent user service..."
  "$INSTALL_DIR/bin/burrow" service install
  verify_restarted_runtime
fi
rm -f "$INSTALL_DIR/.service-install-pending"
# Deleting the prior app can take tens of seconds when it contains installed
# dependencies. It is cleanup, not activation; never hold runtime downtime
# hostage to recursive deletion.
if [ -d "$PREVIOUS" ]; then
  verbose_log "cleaning previous application payload after service recovery"
  rm -rf "$PREVIOUS"
fi
verbose_log "activation complete"
printf "%s\\n" "Burrow install: ok" "Home: $INSTALL_DIR" "Application: $INSTALL_DIR/app" "State: $INSTALL_DIR/{config,workspace,cache}" "Update: $INSTALL_DIR/bin/burrow update"
if [ "$FRESH_INSTALL" -eq 1 ] && [ "$INSTALL_SERVICE" -eq 1 ] || [ "$RESTART_SERVICE" -eq 1 ]; then
  runtime_endpoint
  printf '%s\n' "Ready: http://$host:$port" "Service: $INSTALL_DIR/bin/burrow service status"
else
  printf '%s\n' "Service policy unchanged. Start manually if needed: $INSTALL_DIR/bin/burrow serve"
fi
