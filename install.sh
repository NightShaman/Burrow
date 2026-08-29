#!/bin/sh
# Burrow user-local installer. It replaces app while preserving runtime state.
set -eu
REPOSITORY="NightShaman/Burrow"
INSTALL_DIR="${HOME}/.burrow"
SOURCE_DIR=""
MODE="ui"
INSTALL_DEPS=1
UNINSTALL=0
PURGE=0
ASSUME_YES=0
INSTALL_NODE=0
RESTART_SERVICE=0
usage() { cat <<USAGE
Usage: install.sh [options]
  --dir PATH                    installation and durable-state root
  --source-dir PATH             assembled Burrow checkout; do not download
  --headless                    install runtime without web UI assets
  --no-install-dependencies     skip npm ci/build (development only)
  --install-node                install Node.js 24 LTS on supported Linux when required
  --uninstall                   remove installed application files
  --purge                       with --uninstall, also remove all durable state
  --yes                         do not prompt for uninstall confirmation
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
    --headless) MODE=headless; shift ;;
    --no-install-dependencies) INSTALL_DEPS=0; shift ;;
    --install-node) INSTALL_NODE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Burrow install: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$UNINSTALL" -eq 1 ]; then
  [ -z "$SOURCE_DIR" ] || { echo "Burrow uninstall: --source-dir is not valid with --uninstall." >&2; exit 2; }
  [ -d "$INSTALL_DIR" ] || { echo "Burrow uninstall: no installation at $INSTALL_DIR." >&2; exit 1; }
  INSTALL_DIR=$(cd "$INSTALL_DIR" && pwd)
  [ "$INSTALL_DIR" != "/" ] || { echo "Burrow uninstall: refusing to remove /." >&2; exit 1; }
  if [ "$PURGE" -eq 1 ]; then
    ACTION="remove $INSTALL_DIR, including config, workspace, agentdata, cache, and reports"
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
  if [ -f "$SERVICE_UNIT" ] && command -v systemctl >/dev/null 2>&1; then
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
    printf "%s\n" "Burrow uninstall: application removed" "Preserved: $INSTALL_DIR/{config,workspace,agentdata,cache,reports,integrations,burrow.env}"
  fi
  exit 0
fi

TMP_ROOT=""
cleanup() { [ -z "$TMP_ROOT" ] || rm -rf "$TMP_ROOT"; }
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
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $SUDO gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
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
  if [ "$INSTALL_NODE" -eq 1 ]; then
    install_node_24
  elif [ -t 0 ]; then
    printf 'Burrow requires Node.js 24 LTS or newer. Install Node.js 24 LTS now? [y/N] '
    read -r answer || answer=""
    case "$answer" in y|Y|yes|YES) install_node_24 ;; *) echo "Burrow install: Node.js 24+ is required. Re-run with --install-node on Ubuntu or RHEL-family Linux, or install it manually." >&2; exit 1 ;; esac
  else
    echo "Burrow install: Node.js 24+ is required. Re-run with --install-node on Ubuntu or RHEL-family Linux, or install it manually." >&2
    exit 1
  fi
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
  command -v systemctl >/dev/null 2>&1 || { echo "Burrow update: a Burrow user service exists but systemctl is unavailable; refusing an update that cannot restart it." >&2; exit 1; }
  user_systemctl show-environment >/dev/null 2>&1 || { echo "Burrow update: could not reach the Burrow user-service manager; refusing an update that cannot restart it." >&2; exit 1; }
  RESTART_SERVICE=1
}

verify_restarted_runtime() {
  # The assembled GitHub payload writes this immutable build version during
  # assembly. Development/source-dir installs may not have assembly metadata,
  # so retain the package-version fallback for that supported path.
  expected_version=$(awk '$1 == "Burrow-Build-Version" { print $2; exit }' "$INSTALL_DIR/app/SOURCE_VERSIONS" 2>/dev/null || true)
  [ -n "$expected_version" ] || expected_version=$(node -p "require('$INSTALL_DIR/app/backend/package.json').version")
  host=$(grep '^BURROW_UI_HOST=' "$ENV_FILE" | cut -d= -f2- || true)
  port=$(grep '^BURROW_UI_PORT=' "$ENV_FILE" | cut -d= -f2- || true)
  host=${host:-127.0.0.1}
  port=${port:-42817}
  [ "$host" = "0.0.0.0" ] && host=127.0.0.1
  # A cold Node runtime can take longer than the former 15-second probe window,
  # especially after native modules and UI assets were replaced. The expected
  # version comes from the assembled payload's GitHub-generated build metadata,
  # not a manually maintained release number. Wait for the unit to become
  # active and retain final facts if readiness fails.
  last_unit_state=unknown
  last_health=unreachable
  for attempt in $(seq 1 180); do
    last_unit_state=$(user_systemctl is-active burrow.service 2>/dev/null || true)
    if [ "$last_unit_state" = active ]; then
      last_health=$(curl -fsS --max-time 2 "http://$host:$port/api/health" 2>/dev/null || true)
      case "$last_health" in *"\"version\":\"$expected_version\""*) return 0 ;; esac
    fi
    sleep 1
  done
  observed_version=$(printf '%s' "$last_health" | sed -n 's/.*"version":"\\([^"}]*\\)".*/\1/p' | head -n 1)
  if [ -n "$observed_version" ]; then
    echo "Burrow update: service is $last_unit_state but health reported version $observed_version, expected $expected_version after 180 seconds." >&2
  elif [ "$last_unit_state" != active ]; then
    echo "Burrow update: burrow.service is $last_unit_state after restart; health never became reachable within 180 seconds." >&2
  else
    echo "Burrow update: burrow.service is active but health at http://$host:$port/api/health never reported version $expected_version within 180 seconds." >&2
  fi
  exit 1
}

if [ -z "$SOURCE_DIR" ]; then
  command -v curl >/dev/null 2>&1 || { echo "Burrow install: curl is required." >&2; exit 1; }
  TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/burrow-install.XXXXXX")
  curl -fsSL "https://github.com/${REPOSITORY}/archive/refs/heads/main.tar.gz" -o "$TMP_ROOT/burrow.tar.gz"
  tar -xzf "$TMP_ROOT/burrow.tar.gz" -C "$TMP_ROOT"
  SOURCE_DIR=$(find "$TMP_ROOT" -mindepth 1 -maxdepth 1 -type d -name "Burrow-*" | head -n 1)
fi
[ -n "$SOURCE_DIR" ] && [ -f "$SOURCE_DIR/backend/package.json" ] && [ -f "$SOURCE_DIR/ui/package.json" ] || { echo "Burrow install: source is not an assembled Burrow checkout: ${SOURCE_DIR:-unknown}" >&2; exit 1; }
INSTALL_DIR=$(mkdir -p "$INSTALL_DIR" && cd "$INSTALL_DIR" && pwd)
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
prepare_service_restart
# An update is entered through the absolute launcher, but package lifecycle
# scripts may invoke `burrow`. Keep the active installation launcher visible
# throughout staging rather than depending on a login-shell PATH.
case ":$PATH:" in
  *":$INSTALL_DIR/bin:"*) ;;
  *) PATH="$INSTALL_DIR/bin:$PATH"; export PATH ;;
esac
mkdir -p "$INSTALL_DIR/config" "$INSTALL_DIR/workspace" "$INSTALL_DIR/agentdata" "$INSTALL_DIR/cache" "$INSTALL_DIR/reports" "$INSTALL_DIR/integrations" "$INSTALL_DIR/bin"
STAGING="$INSTALL_DIR/.app-staging-$$"
PREVIOUS="$INSTALL_DIR/.app-previous"
rm -rf "$STAGING" "$PREVIOUS"; mkdir -p "$STAGING"
cp -R "$SOURCE_DIR/backend" "$STAGING/backend"
cp "$SOURCE_DIR/install.sh" "$STAGING/install.sh"
[ -f "$SOURCE_DIR/SOURCE_VERSIONS" ] && cp "$SOURCE_DIR/SOURCE_VERSIONS" "$STAGING/SOURCE_VERSIONS" || true
chmod 0755 "$STAGING/install.sh"
[ "$INSTALL_DEPS" -ne 1 ] || ensure_node_24
if [ "$MODE" = "ui" ]; then
  cp -R "$SOURCE_DIR/ui" "$STAGING/ui"
  if [ "$INSTALL_DEPS" -eq 1 ]; then
    (cd "$STAGING/ui" && npm ci && npm run build)
    mkdir -p "$STAGING/backend/public/ui"; cp -R "$STAGING/ui/dist/." "$STAGING/backend/public/ui/"
  fi
fi
if [ "$INSTALL_DEPS" -eq 1 ]; then
  # These are runtime-owned integrations, not application dependencies. Stage
  # them before activation so a failed install cannot leave a partial runtime.
  mkdir -p "$STAGING/integrations/mcporter" "$STAGING/integrations/claude-code"
  (cd "$STAGING/backend" && npm ci --omit=dev && node -e "import('node-llama-cpp')")
  npm install --prefix "$STAGING/integrations/mcporter" --omit=dev --no-package-lock --no-save mcporter@0.13.7
  cat > "$STAGING/integrations/claude-code/package.json" <<'PACKAGE'
{
  "private": true,
  "dependencies": { "@anthropic-ai/claude-code": "2.1.232" },
  "allowScripts": { "@anthropic-ai/claude-code@2.1.232": true }
}
PACKAGE
  npm install --prefix "$STAGING/integrations/claude-code" --omit=dev --no-package-lock --ignore-scripts=false
  "$STAGING/integrations/claude-code/node_modules/.bin/claude" --version >/dev/null
fi
ENV_FILE="$INSTALL_DIR/burrow.env"
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<ENV
# Durable Burrow runtime state. Updates preserve this file.
BURROW_RUNTIME_ROOT=$INSTALL_DIR
BURROW_WORKSPACE_ROOT=$INSTALL_DIR/workspace
BURROW_AGENT_DATA_ROOT=$INSTALL_DIR/agentdata
BURROW_CACHE_ROOT=$INSTALL_DIR/cache
BURROW_SETTINGS_DB=$INSTALL_DIR/config/settings.sqlite
BURROW_CLAUDE_BIN=$INSTALL_DIR/integrations/claude-code/node_modules/.bin/claude
# 32-byte AES-256 key for encrypted model/provider settings. Keep this file private.
BURROW_SETTINGS_KEY=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')
BURROW_UI_HOST=127.0.0.1
BURROW_UI_PORT=42817
ENV
fi
if ! grep -q '^BURROW_SETTINGS_KEY=' "$ENV_FILE"; then
  umask 077
  printf '%s=%s\n' 'BURROW_SETTINGS_KEY' "$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')" >> "$ENV_FILE"
fi
# Replace the service launcher atomically. The running service and an update
# invoked through this launcher may still have the previous inode open; direct
# truncation can fail with ETXTBSY and leaves a half-written command behind.
WRAPPER_TMP="$INSTALL_DIR/bin/.burrow-launcher-$$"
rm -f "$WRAPPER_TMP"
cat > "$WRAPPER_TMP" <<WRAPPER
#!/bin/sh
set -eu
BURROW_HOME="\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)"
[ ! -f "\$BURROW_HOME/burrow.env" ] || { set -a; . "\$BURROW_HOME/burrow.env"; set +a; }
# The launcher location is authoritative after a portable restore; never let a
# copied burrow.env redirect the active installation back to its former home.
export BURROW_RUNTIME_ROOT="\$BURROW_HOME"
case "\${1:-}" in
  update) shift; exec "\$BURROW_HOME/app/install.sh" --dir "\$BURROW_HOME" "\$@" ;;
  uninstall) shift; exec "\$BURROW_HOME/app/install.sh" --dir "\$BURROW_HOME" --uninstall "\$@" ;;
  service)
    shift
    SERVICE_ACTION="\${1:-status}"
    SERVICE_DIR="\${XDG_CONFIG_HOME:-\$HOME/.config}/systemd/user"
    SERVICE_UNIT="\$SERVICE_DIR/burrow.service"
    command -v systemctl >/dev/null 2>&1 || { echo "Burrow service: systemd user services are unavailable." >&2; exit 1; }
    case "\$SERVICE_ACTION" in
      install)
        # A service install promises persistence across logout and reboot.
        # `burrow serve` remains the explicit session-only option.
        command -v loginctl >/dev/null 2>&1 || { echo "Burrow service: loginctl is required to enable persistent user services; use 'burrow serve' for a session-only runtime." >&2; exit 1; }
        SERVICE_USER="\$(id -un)"
        if ! loginctl enable-linger "\$SERVICE_USER" >/dev/null 2>&1 || [ "\$(loginctl show-user "\$SERVICE_USER" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
          echo "Burrow service: could not enable lingering for \$SERVICE_USER; service installation requires lingering to persist after logout and reboot. Use 'burrow serve' for a session-only runtime." >&2
          exit 1
        fi
        mkdir -p "\$SERVICE_DIR"
        # systemd user services do not inherit the login shell PATH. Preserve
        # the current baseline and include npm's user-global bin directory so
        # MCPs that legitimately invoke user-installed CLIs work normally.
        SERVICE_PATH="\$PATH"
        NPM_GLOBAL_PREFIX="\$(npm prefix -g 2>/dev/null || true)"
        NPM_GLOBAL_BIN="\${NPM_GLOBAL_PREFIX:+\$NPM_GLOBAL_PREFIX/bin}"
        if [ -n "\$NPM_GLOBAL_BIN" ] && [ -d "\$NPM_GLOBAL_BIN" ]; then
          case ":\$SERVICE_PATH:" in
            *":\$NPM_GLOBAL_BIN:"*) ;;
            *) SERVICE_PATH="\$NPM_GLOBAL_BIN:\$SERVICE_PATH" ;;
          esac
        fi
        cat > "\$SERVICE_UNIT" <<UNIT
[Unit]
Description=Burrow runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="PATH=\$SERVICE_PATH"
EnvironmentFile=\$BURROW_HOME/burrow.env
ExecStart=\$BURROW_HOME/bin/burrow serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
        systemctl --user daemon-reload
        systemctl --user enable --now burrow.service
        echo "Burrow service: installed, started, and persistent for \$SERVICE_USER."
        ;;
      uninstall)
        systemctl --user disable --now burrow.service || true
        rm -f "\$SERVICE_UNIT"
        systemctl --user daemon-reload
        echo "Burrow service: removed."
        ;;
      start|stop|restart|status) exec systemctl --user "\$SERVICE_ACTION" burrow.service ;;
      logs) shift; exec journalctl --user-unit burrow.service --no-pager "\$@" ;;
      *) echo "Usage: burrow service {install|uninstall|start|stop|restart|status|logs}" >&2; exit 2 ;;
    esac
    ;;
  serve) shift; exec node "\$BURROW_HOME/app/backend/bin/burrow.mjs" serve --root "\$BURROW_HOME/app/backend" "\$@" ;;
  install-backup) shift; exec node "\$BURROW_HOME/app/backend/bin/burrow.mjs" install-backup --root "\$BURROW_HOME" "\$@" ;;
  install-restore) shift; exec node "\$BURROW_HOME/app/backend/bin/burrow.mjs" install-restore "\$@" ;;
  *) exec node "\$BURROW_HOME/app/backend/bin/burrow.mjs" "\$@" --root "\$BURROW_HOME/app/backend" ;;
esac
WRAPPER
chmod 0755 "$WRAPPER_TMP"
mv -f "$WRAPPER_TMP" "$INSTALL_DIR/bin/burrow"
[ ! -d "$INSTALL_DIR/app" ] || mv "$INSTALL_DIR/app" "$PREVIOUS"
if ! mv "$STAGING" "$INSTALL_DIR/app"; then [ ! -d "$PREVIOUS" ] || mv "$PREVIOUS" "$INSTALL_DIR/app"; echo "Burrow install: could not activate new app payload." >&2; exit 1; fi
if [ "$INSTALL_DEPS" -eq 1 ]; then
  for integration in mcporter claude-code; do
    rm -rf "$INSTALL_DIR/integrations/$integration"
    mv "$INSTALL_DIR/app/integrations/$integration" "$INSTALL_DIR/integrations/$integration"
  done
  rmdir "$INSTALL_DIR/app/integrations" 2>/dev/null || true
fi
rm -rf "$PREVIOUS"
if [ "$RESTART_SERVICE" -eq 1 ]; then
  user_systemctl restart burrow.service
  verify_restarted_runtime
fi
printf "%s\\n" "Burrow install: ok" "Home: $INSTALL_DIR" "Application: $INSTALL_DIR/app" "State: $INSTALL_DIR/{config,workspace,agentdata,cache}" "Run: $INSTALL_DIR/bin/burrow serve" "Update: $INSTALL_DIR/bin/burrow update"
