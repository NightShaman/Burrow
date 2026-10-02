# Troubleshooting

Start with the installed version, exact error, expected deployment shape, and relevant agent/session/run ID. Avoid changing several settings at once or retrying an operation that may still be running.

## First checks

For the native user-service installation:

```sh
"$HOME/.burrow/bin/burrow" service status
"$HOME/.burrow/bin/burrow" service logs -n 200
curl -fsS http://127.0.0.1:42817/health
cat "$HOME/.burrow/app/SOURCE_VERSIONS"
```

For containers, use `docker compose ps` and `docker compose logs --tail=200 burrow`. Inspect JSON `ok` and version, not only the HTTP status. Keep credentials and full environment files out of diagnostic bundles.

## Service fails to start

| Evidence | Check |
|---|---|
| PostgreSQL binary missing | PostgreSQL17/pgvector packages or explicit binary paths |
| Managed mode rejects root | Run as the installation owner, not root |
| External target/extension error | Database17, vector installed, TLS/credentials/migration privileges |
| Settings key mismatch/decryption error | Restore matching key and database; do not generate a replacement key |
| `EADDRINUSE` | Another service/foreground process owns the listener |
| Cannot reach user service manager | OS user manager/lingering and correct account |
| Container permission error | Numeric UID/GID can write the intended volume |
| Integration bootstrap failure | npm connectivity, configured integration directory, executable/package state |

The managed database lives below the runtime root and uses a private socket. It is not necessarily the host's default `localhost:5432` PostgreSQL server.

## First-run profile error

In this reviewed snapshot, the wizard sends five profile document kinds and the backend requires six. `agent_profile_documents_complete_set_required` can occur after operator/agent creation.

First inspect `/api/agents` and the existing agent's profile documents. Use the regular **Settings → Agents → Profile documents** editor, which includes `PREFERENCES`, rather than repeatedly creating a duplicate agent. If the first-run dialog prevents normal recovery, an operator can use the documented API to replace the **complete** six-kind profile set, preserving existing text, and finish setup.

The following recovery example is for initial loopback setup with authentication still disabled. If authentication is configured, use that installation's supported authenticated client; do not disable it for convenience. Replace `AGENT_ID` with the already-created agent ID:

```sh
BASE=http://127.0.0.1:42817
AGENT_ID=assistant
umask 077
curl -fsS "$BASE/api/agents/$AGENT_ID/profile-documents" -o profiles-current.json
python3 - <<'PYCODE'
import json
from pathlib import Path
import re
source = json.loads(Path('profiles-current.json').read_text())
by_kind = {item['kind']: item['markdown'] for item in source['documents']}
kinds = ['SOUL', 'RULES', 'ORIENTATION', 'PREFERENCES', 'TOOLS', 'DREAM_MEMORY']
Path('profiles-complete.json').write_text(json.dumps({
    'documents': [{'kind': kind, 'markdown': by_kind.get(kind, '')} for kind in kinds]
}))
PYCODE
```

Review `profiles-complete.json`, including any intended SOUL text that the failed wizard did not save. Then deliberately apply it and finish setup:

```sh
curl -fsS -X PUT -H 'Content-Type: application/json' \
  --data-binary @profiles-complete.json \
  "$BASE/api/agents/$AGENT_ID/profile-documents"
curl -fsS -X POST -H 'Content-Type: application/json' -d '{}' \
  "$BASE/api/setup/complete"
```

Completion still requires a persisted nonempty operator name and a named agent. Reload the UI, configure the model, and verify a conversation. Securely remove temporary profile copies when no longer needed. This is a workaround using existing APIs, not a runtime fix.

## Update reports health failure

The updater restarts an existing user service, then fetches `/api/health` without credentials. With UI authentication enabled, 401 can cause verification to report failure even though the service is active.

Inspect the installed `SOURCE_VERSIONS`, current process logs, and an authorized health response. Do not assume the old app was automatically restored, and do not repeatedly update without establishing what is running. See [upgrade boundaries](upgrades.md#failure-and-rollback-boundaries).

## API documentation does not load

The server expects `backend/docs/openapi.json` for `/api/openapi.json`, but the current assembly does not package upstream Backend docs. The Scalar page can load while its schema request fails. Use this site's [API reference](../reference/api.md) and note the packaging limitation; copying files into a running app is not part of documentation maintenance.

## Model configuration or provider failure

Check three separate facts: the connection is saved with usable auth, the exact model is enabled, and the intended agent selects it. Discovery failure can leave manual configuration available. Inspect a sanitized provider error and relevant trace before changing model IDs or credentials.

For Claude CLI-backed login, verify the runtime-owned integration executable path rather than copying a developer's global npm path. For context/multimodal problems, inspect the actual provider request and persisted evidence before assuming a UI rendering defect.

## Chat appears stuck or disconnected

A closed browser can leave a detached server-side run. Inspect active runs for the correct agent/session; use `/stop` or explicit cancellation. A successful cancel request is not proof that every external side effect was undone. If a child is still running, inspect that child's status and evidence.

For NDJSON clients, parse terminal payloads. HTTP200 and `run.completed` do not imply `response.ok=true`.

## History or memory appears missing

Check agent/session identity, archived/reset history, date/timezone filters, pagination cursors, and the difference between transcript search, working memory, rolling continuity, and durable knowledge. A prompt-context window is not the complete stored transcript. See [conversation history](../concepts/conversation-history.md) and [memory](../concepts/memory.md).

## Disk growth and retention

Preview cleanup and inspect the selected retention policy before confirming. Current persistence includes PostgreSQL and filesystem artifacts; old “trace-only” runbooks are not universal statements about all current retention settings. Back up before destructive changes. Use [storage schema](../reference/storage-schema.md) and [procedures](procedures.md#retention-maintenance).

## Escalation checklist

Include build version/source pins, deployment shape, sanitized exact error, relevant IDs, attempted steps, and terminal check results. Exclude settings keys, tokens/passwords, raw environment dumps, and unrelated conversation material. Distinguish a static source limitation from a reproduced failure.

## Source evidence

- [Wizard profile kinds](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/ui/src/features/settings/AgentToolbar.tsx#L8-L8)
- [Complete-set validation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-agent-profile-store.mjs#L46-L58)
- [Update verification](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/install.sh#L211-L246)
- [API spec file read](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L3225-L3232)
