#!/bin/sh
set -eu

key_file="${BURROW_SETTINGS_KEY_FILE:-/data/config/settings.key}"
supplied_key="${BURROW_SETTINGS_KEY:-}"

if [ -n "$supplied_key" ] && [ "$supplied_key" != "***" ]; then
  if [ -s "$key_file" ]; then
    persisted_key="$(cat "$key_file")"
    if [ "$persisted_key" != "$supplied_key" ]; then
      echo "BURROW_SETTINGS_KEY does not match the persisted key at $key_file" >&2
      echo "Restore the matching key and settings database together; refusing to start with split key state." >&2
      exit 1
    fi
  else
    mkdir -p "$(dirname "$key_file")"
    umask 077
    printf "%s\n" "$supplied_key" > "$key_file"
  fi
  BURROW_SETTINGS_KEY="$supplied_key"
elif [ -s "$key_file" ]; then
  BURROW_SETTINGS_KEY="$(cat "$key_file")"
else
  mkdir -p "$(dirname "$key_file")"
  BURROW_SETTINGS_KEY="$(node -e "process.stdout.write(require(\"node:crypto\").randomBytes(32).toString(\"base64\"))")"
  umask 077
  printf "%s\n" "$BURROW_SETTINGS_KEY" > "$key_file"
fi

export BURROW_SETTINGS_KEY

# CLI integrations are derived runtime state. Keep them under the persistent
# runtime root so regular and container installs share one layout, and only
# contact npm when a pinned integration is missing or stale.
node /opt/burrow/scripts/ensure-runtime-integrations.mjs
export BURROW_MCPORTER_ROOT="${BURROW_MCPORTER_ROOT:-${BURROW_RUNTIME_ROOT}/integrations/mcporter}"
export BURROW_MCPORTER_BIN="${BURROW_MCPORTER_BIN:-${BURROW_MCPORTER_ROOT}/node_modules/.bin/mcporter}"
export BURROW_CLAUDE_BIN="${BURROW_CLAUDE_BIN:-${BURROW_RUNTIME_ROOT}/integrations/claude-code/node_modules/.bin/claude}"

exec "$@"
