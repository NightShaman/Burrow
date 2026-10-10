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

The `2026.10.10.4` wizard sends five profile kinds; the backend requires six, including `PREFERENCES`. The error is `agent_profile_documents_complete_set_required`. Retrying the same payload cannot repair it.

1. Check `GET /api/setup/status` and `GET /api/agents` using your deployment's normal authentication.
2. If the failed attempt was the current wizard's `/api/setup/operation`, its identity, agent, profile and completion writes roll back together. Do not assume there is an agent to repair. A separately created OAuth connection may remain.
3. If an older install already has an agent, preserve its existing profile text. Use **Settings → Agents → Profile documents** when accessible, or the complete six-kind profile replacement API. Never replace existing documents with blank examples. Once the named operator, named agent and repaired profiles are present, finish with `POST /api/setup/complete`, check that setup status is ready, and reload.
4. For a genuinely fresh installation, either use a release with the wizard mismatch corrected, or have its operator submit a complete setup operation through the existing API as below. This is a source-backed workaround, not a runtime fix or an independently executed setup test.

### Fresh-install API workaround

Only use this example after confirming that the chosen agent ID does not exist and that you intend to set the operator identity. It creates an enabled agent and its default Dream settings; review background schedules before connecting a metered model. Do not run it against an already configured installation.

Create a private `setup.json` file with this shape, replacing the fictional name and profile text. Include all six documents. `modelSelection` is deliberately omitted so you can configure a model afterward in Settings.

```json
{
  "operationId": "initial-setup-assistant-2026-10-10",
  "operator": { "name": "Your display name", "avatar": "" },
  "agent": { "id": "assistant", "name": "Assistant", "enabled": true },
  "agentIdentity": { "avatar": "" },
  "documents": [
    { "kind": "SOUL", "markdown": "Describe the agent's role here." },
    { "kind": "RULES", "markdown": "" },
    { "kind": "ORIENTATION", "markdown": "" },
    { "kind": "PREFERENCES", "markdown": "" },
    { "kind": "TOOLS", "markdown": "" },
    { "kind": "DREAM_MEMORY", "markdown": "" }
  ]
}
```

Use a new operation ID for a new intended operation. Keep the same ID and unchanged file when retrying after a lost response: the server replays a completed operation, while reusing its ID with different contents returns a conflict. Do not use a new ID simply to bypass an uncertain outcome; inspect the setup state first.

For initial loopback setup with authentication still disabled:

```sh
chmod 600 setup.json
BASE=http://127.0.0.1:42817
curl --fail-with-body -sS -X POST -H 'Content-Type: application/json' \
  --data-binary @setup.json "$BASE/api/setup/operation"
curl --fail-with-body -sS "$BASE/api/setup/status"
```

If authentication is configured, use an authorized client instead. For Basic authentication, add `--user "$BURROW_USERNAME"` and let curl prompt; never disable authentication for this workaround. An OIDC-only deployment needs its authenticated session/client.

Expected result: the operation returns `ok: true` and the intended agent, and setup status reports `configured: true` / `wizardStep: "ready"`. Reload the UI, review the saved profiles and schedules, then follow [model setup](../getting-started/initial-setup.md#configure-a-usable-model). Retain the request privately until an uncertain response is resolved, then remove the temporary copy when no longer needed. Do not put credentials in it.

[Wizard submission](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/settings/AgentToolbar.tsx) · [Transactional operation and replay](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/setup-operation.mjs) · [Six-kind validator](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-agent-profile-store.mjs) · [Setup requirements](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-setup-state-store.mjs).

## Update reports health failure

Both `/health` and `/api/health` now return a small public build-identity response before the authentication gate. A 401 caused solely by Burrow's own UI auth is no longer the expected behavior; a reverse proxy may have its own gate.

Check the service status and logs, then compare the installed `SOURCE_VERSIONS` with the response's version/build identity. A health response alone does not prove the provider, tools, or database-backed workflows work. Do not assume an automatic rollback or repeat updates until you know which app is running. See [upgrade boundaries](upgrades.md#failure-and-rollback-boundaries).

## Upgrade waits on a database migration

A PostgreSQL process title ending in `DO` identifies a SQL block, not how far it has progressed. Runtime startup applies pending migrations before starting the HTTP server, so the UI or health endpoint may be unavailable during this stage. Duration depends on the starting schema, retained data and storage; there is no fixed completion time in this guide.

### Check the process and logs first

1. Record the installed `SOURCE_VERSIONS` and the service's latest logs using the [first checks](#first-checks). Avoid launching another update or server against the same installation.
2. On Linux, inspect the **actual PostgreSQL backend PID** from your process listing:

    ```sh
    PID=12345  # replace with the backend PID you are investigating
    ps -p "$PID" -o pid,etime,time,pcpu,stat,args
    ```

    `ELAPSED` (`etime`) is wall-clock time since that process started; `TIME` is cumulative CPU time. Neither is the current migration's elapsed time. Compare two observations of the same PID rather than treating one CPU value or process title as proof of a hang. [procps ps reference](https://man7.org/linux/man-pages/man1/ps.1.html)

3. Review service logs and, for default managed paths, `$HOME/.burrow/postgres.log`. Use the configured log path if overridden. Do not copy the whole private environment or unreviewed logs into a public issue.

Do **not** use `burrow doctor`, `trace`, or other store-composing CLI readers as a migration progress probe: those paths can themselves enter migration checking and wait for the same migration lock.

### Inspect database waits without starting another migration

The following is for an **already running, native managed** database, as its installation's OS owner. It uses `psql` directly and a read-only session, without composing Burrow application stores. It does not start PostgreSQL or create a database role.

Confirm the actual socket directory first. The default is `$HOME/.burrow/postgres-socket`; an overridden `BURROW_POSTGRES_SOCKET_DIR` or custom install root changes it. Managed mode uses port 5432, database `postgres`, and the installation owner's OS username, with TCP disabled. Do not substitute the host's default `localhost` database.

```sh
(
  PSQL=$(command -v psql || true)
  if [ -z "$PSQL" ] && [ -x /usr/lib/postgresql/17/bin/psql ]; then
    PSQL=/usr/lib/postgresql/17/bin/psql
  fi
  if [ -z "$PSQL" ]; then
    echo 'psql not found: locate the installed PostgreSQL client before continuing.' >&2
    exit 1
  fi
  SOCKET="$HOME/.burrow/postgres-socket"  # use the verified configured directory
  unset PGSERVICE PGSERVICEFILE PGHOSTADDR PGPASSWORD
  PGCONNECT_TIMEOUT=5 \
  PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' \
  "$PSQL" -X -w -v ON_ERROR_STOP=1 \
    -h "$SOCKET" -p 5432 -U "$(id -un)" -d postgres <<'SQL'
SELECT pid, state,
       clock_timestamp() - query_start AS query_age,
       clock_timestamp() - xact_start AS transaction_age,
       wait_event_type, wait_event,
       pg_blocking_pids(pid) AS blocking_pids
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
ORDER BY query_start;
SQL
)
```

The versioned client path is a common Debian/Ubuntu location, not a universal requirement. If neither client lookup succeeds, stop and locate the existing client in the configured PostgreSQL installation; `command not found` does not establish a database failure. If the connection fails, check owner, socket and lifecycle settings. Do not change authentication or permissions to make this probe work. For external databases or containers, use that deployment's existing authorized database client and connection instead of the native example.

- `blocking_pids` identifies lock blockers; investigate their owners before deciding what to do.
- `active` can still be waiting. A `Lock` wait points to lock contention; `IO` indicates an I/O wait. Empty wait fields do not prove useful progress or imminent completion.
- Query age describes the current active statement; transaction age can include multiple statements. For an inactive backend, query information refers to its last query.
- Repeat as a new invocation for a fresh observation. Generic `DO` blocks have no universal percentage-complete view. Missing activity detail can reflect insufficient monitoring privileges, not an idle server.

[PostgreSQL activity fields](https://www.postgresql.org/docs/17/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW) · [Blocking PID function](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-INFO-SESSION-TABLE)

Burrow holds a transaction-scoped advisory lock and applies pending migrations in one transaction. Another process may therefore be waiting for the migration owner. The ledger writes commit with that transaction: an unchanged ledger observed from a second connection is not proof that the migration is idle or stuck.

If diagnosis remains inconclusive, preserve the build, PID, elapsed observations, wait/blocker details and sanitized errors for investigation. Do not kill the backend, restart repeatedly, clear the migration ledger, edit checksums or force an older app onto the database as a progress test. Any interruption or recovery needs a deliberate plan and a restorable backup.

[Startup ordering and private-socket identity](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-startup.mjs) · [Migration transaction and lock](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-migrations.mjs) · [CLI composition](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/cli-postgres.mjs).

## API documentation does not load

The server expects `backend/docs/openapi.json` for `/api/openapi.json`, but the current assembly does not package upstream Backend docs. The Scalar page can load while its schema request fails. Use this site's [API reference](../reference/api.md) and note the packaging limitation; copying files into a running app is not part of documentation maintenance.

## Model configuration or provider failure

Check three separate facts: the connection is saved with usable auth, the exact model is enabled, and the intended agent selects it. Discovery failure can leave manual configuration available. Inspect a sanitized provider error and relevant trace before changing model IDs or credentials.

For Claude CLI-backed login, verify the runtime-owned integration executable path rather than copying a developer's global npm path. For context/multimodal problems, inspect the actual provider request and persisted evidence before assuming a UI rendering defect.

## Chat appears stuck or disconnected

A closed browser can leave a detached server-side run. Inspect active runs for the correct agent/session; use `/stop` or explicit cancellation. A successful cancel request is not proof that every external side effect was undone. If a child is still running, inspect that child's status and evidence.

For NDJSON clients, parse terminal payloads. HTTP200 and `run.completed` do not imply `response.ok=true`.

## A cached-token count is low or absent

There is no operator control to force a cache hit or warm a session. The provider decides whether a request is reused. Switching models/providers or changing the earlier prompt can affect reuse; one short request is not a useful cache test. Keep the same connection and conversation for comparison, inspect actual provider usage when returned, and keep wire/debug output private. A matching local fingerprint is diagnostic evidence, not a provider cache receipt. See [model cache behavior](../concepts/models.md).

## History or memory appears missing

Check agent/session identity, archived/reset history, date/timezone filters, pagination cursors, and the difference between original conversations and Brains saved memories. Brains is deliberate memory: it does not automatically ingest every chat, and deleting a Brains card does not purge its original conversation. A prompt-context window is not the complete stored transcript. See [conversation history](../concepts/conversation-history.md) and [memory](../concepts/memory.md).

## Disk growth and retention

Preview cleanup and inspect the selected retention policy before confirming. Current persistence includes PostgreSQL and filesystem artifacts; old “trace-only” runbooks are not universal statements about all current retention settings. Back up before destructive changes. Use [storage schema](../reference/storage-schema.md) and [procedures](procedures.md#retention-maintenance).

## Escalation checklist

Include build version/source pins, deployment shape, sanitized exact error, relevant IDs, attempted steps, and terminal check results. Exclude settings keys, tokens/passwords, raw environment dumps, and unrelated conversation material. Distinguish a static source limitation from a reproduced failure.

## Source evidence

- [Wizard profile kinds](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/settings/AgentToolbar.tsx)
- [Complete-set validation](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-agent-profile-store.mjs)
- [Update verification](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/install.sh)
- [API spec file read](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs)
