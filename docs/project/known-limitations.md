# Known limitations

These limitations apply to the [documented source baseline](source-map.md). They are source-backed implementation or packaging observations, not claims about every release or an independently tested running installation. Recheck them when upgrading.

## Configuration and command compatibility

### `burrow.json` is not the application configuration authority

The retained loader deliberately does not read JSON application configuration. Editing an old `burrow.json` does not configure the current runtime. Use PostgreSQL-backed settings and the service environment described in [configuration](../reference/configuration.md).

Source: [`config.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L51-L60).

### Dream CLI commands are advertised but incompletely dispatched

The direct CLI accepts and advertises `dream-memory` and `dream-cycle`, but neither has its own working dispatch branch in this snapshot. They fall through toward generic plan handling and message requirements. Use the documented [Dream UI/API surfaces](../concepts/dreams.md); do not assume the help text proves a CLI cycle ran.

Source: [`backend/bin/burrow.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/bin/burrow.mjs). See [CLI distinctions](../reference/cli.md).

### Direct model CLI commands lack current store wiring

The direct CLI calls the model resolver without the model-settings store required by the current implementation before dispatching `ask`, `chat`, `plan`, `run`, `factory`, and the Dream names. The doctor path has a related missing-store call. These source-level paths can fail with `model_settings_store_required`; the HTTP chat path supplies its stores separately. Do not use those CLI commands as verified operational chat or health recipes in this snapshot.

Sources: [`burrow.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/bin/burrow.mjs#L399-L407), [`config.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L90-L99). See [CLI](../reference/cli.md) for working versus incomplete surfaces.

### Some package scripts reference absent files

`runtime:restore:rehearsal` references a missing `scripts/runtime-restore-rehearsal.mjs`. The aggregate `openapi:check` references a missing `tests/live-api-contract.test.mjs` even in the inspected upstream source snapshot. The public assembly also omits the Backend test and docs trees more generally.

Use the [developer setup](../development/setup.md) instructions and explicitly report skipped or blocked checks. Do not equate the existence of an npm script with a runnable acceptance test.

Source: [`backend/package.json`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/package.json).

## Installation, upgrades, and recovery

### Fresh remote bootstrap needs Node early

The remote installer uses Node during immutable source-revision resolution before its later Node provisioning step. For an otherwise empty host, install the required Node version first or use the documented local assembled-source installation path. Do not assume `--install-node` makes every earlier bootstrap step independent of Node.

Source: [`install.sh`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/install.sh). See [installation](../getting-started/installation.md).

### Authenticated health can confuse update verification

Native update verification fetches `/api/health` without credentials. That route passes through authentication, so an authenticated installation may report update-health failure even when its service is running. Inspect the user service and make an authenticated health request; do not blindly retry or assume a complete rollback occurred.

Sources: [`install.sh`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/install.sh), [`burrow-ui.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs). See [upgrades](../operations/upgrades.md).

!!! warning "Portable installation backup is a cold-copy operation"
    `install-backup` copies files, including managed PostgreSQL data, without stopping the database itself. Stop the runtime and managed database cleanly before this backup. External PostgreSQL requires a separate coordinated database backup. Selective exports and the narrower runtime backup helper do not replace a complete recovery plan.

Source: [`portable-install-backup.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/portable-install-backup.mjs). Follow [backup and recovery](../operations/backup-recovery.md).

### Diagnostic commands can initialize application schema

CLI helpers that construct the PostgreSQL application can apply pending migrations. They do not automatically become read-only merely because their output looks diagnostic. Take and verify a backup before running new-release CLI tools against an older production database.

Sources: [`cli-postgres.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/cli-postgres.mjs), [`postgres-composition.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-composition.mjs).

### CLI retention uses a separate policy source

The `retention` CLI uses environment-derived policy, with default eligible-session ages of main 60 days, task 30 days and subagent 7 days. It does not read the persisted UI trace policy or Albdruck retention policy. A disabled UI policy therefore does not make `retention --confirm` harmless. Preview the full targets with the same environment and explicit agent ID before confirming; `--summary` omits individual target paths. Current/active-session protections still apply.

Sources: [`cli-authority-commands.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/cli-authority-commands.mjs#L21-L27), [`config.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L231-L245). See [retention procedures](../operations/procedures.md#retention-maintenance).

### Session retention has a metadata-shape mismatch

The PostgreSQL session list returns flattened metadata, while the retention planner reads `record.metadata`. As a result, task/subagent kinds and completion fields can be missed and an old task session can be classified as main without checking its board task's terminal status. A read-only injected-store preview reproduces this mismatch; no database deletion was tested. Current/main and native active-run/recovery guards still apply at deletion, but they do not replace the missing board-status check.

Do not rely on the planner's task/subagent eligibility gates in this baseline. Avoid confirmed session cleanup until the mismatch is resolved and tested; trace-only policies are a separate path. Inspect every proposed session target and retain a recovery backup.

Sources: [session projection](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-session-store.mjs#L772-L776), [retention planner](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/retention.mjs#L93-L125), [deletion guards](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-session-store.mjs#L530-L545).

### Portable restore does not rewrite every dependency

The full-install archive contains the install-root tree, preserving symlinks rather than copying their targets. Database or workspace locations outside that tree need coordinated separate backup. Restore rebases runtime, workspace, cache and Claude binary variables; explicit PostgreSQL paths, external database URLs and other absolute overrides remain unchanged. Review them before starting a restored copy so it cannot reconnect to or modify the original deployment.

A raw managed cluster also retains its SQL role names. Filesystem ownership changes do not rename those roles, while managed startup connects using the current OS username. A different target username therefore needs a planned database role/ownership migration; the simple restore path assumes the original owner name. These are source-derived recovery constraints, not a tested cross-account migration procedure.

Sources: [`portable-install-backup.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/portable-install-backup.mjs#L53-L69), [restore rebasing](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/portable-install-backup.mjs#L94-L115), [managed connection](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-startup.mjs#L11-L18). Follow [backup and recovery](../operations/backup-recovery.md).

## API and setup contract gaps

### Packaged API explorer lacks its contract file

The server serves a Scalar API explorer, but reads its contract from `sourceRoot/docs/openapi.json`. The public assembly does not include `backend/docs/openapi.json` at that path. The explorer shell can therefore load while its schema request fails.

The [API reference](../reference/api.md) supplies a source-pinned contract and explains drift. This documentation site does not patch the runtime or claim its `/api/openapi.json` endpoint was repaired.

Source: [`burrow-ui.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L3225-L3239).

### OpenAPI is incomplete

The upstream contract declares OpenAPI 3.1.0 with information version `2026.08.25`. It has 150 paths and 193 operations, but does not define authentication security schemes, omits Dream routes, and has several stale schemas. The existing drift checker scans literal route strings; it does not prove method, regex-route, body, or response parity.

Use the [API reference](../reference/api.md) and [authentication reference](../security/authentication.md) together. Treat generated client types as contract artifacts rather than complete proof of current server behavior.

### Agent setup profile set mismatch

The inspected UI setup flow submits five profile documents while the Backend complete-set validator requires six, including `PREFERENCES`. Setup may therefore persist the operator/agent before rejecting the profile update. Inspect the existing state rather than repeatedly creating the same agent. The [initial setup guide](../getting-started/initial-setup.md) explains the evidence-backed recovery path.

Sources: [`AgentToolbar.tsx`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/ui/src/features/settings/AgentToolbar.tsx), [`postgres-agent-profile-store.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-agent-profile-store.mjs#L46-L50).

### MCP deletion acknowledgement is asynchronous

The MCP connection deletion route forms its response without awaiting the asynchronous removal operation. A successful HTTP response is therefore not definitive removal evidence in this snapshot. Re-list the connections and verify that the record is gone before assuming its credentials, grants and provider lifecycle were removed.

Sources: [`settings-routes.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/settings-routes.mjs#L53-L53), [`burrow-ui.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L393-L400).

## Execution and memory validation limits

### Scheduled execution wiring requires validation

The default scheduler calls the chat runtime without the store adapter required by the current runtime composition. Inspected scheduler tests inject their own execution function. Those tests do not prove that the default server or run-now path completes a real scheduled turn. Treat scheduling configuration separately from observed successful execution and verify terminal receipts before depending on unattended work.

Sources: [`scheduled-job-scheduler.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/scheduled-job-scheduler.mjs), [`app-runtime.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/app-runtime.mjs). See [workers and tasks](../concepts/workers-tasks.md).

### Task-board execution has an asynchronous-store mismatch

The server task execution helper reads asynchronous PostgreSQL task/project/start-execution methods without awaiting their results. Its assigned-agent guard can consequently inspect a Promise rather than the task. Creating or viewing tasks does not establish that the execute action successfully dispatched a turn. Check the response and actual execution receipt.

Sources: [`burrow-ui.mjs`](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/scripts/burrow-ui.mjs#L250-L280), [`postgres-task-board-store.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-task-board-store.mjs). See [workers and tasks](../concepts/workers-tasks.md).

### Status labels can lag policy

Tiddle status text reports a 30-day retention value while the inspected policy/write default is 90 days. Use the actual persisted policy and source-backed [memory reference](../concepts/memory.md), and verify effective settings before cleanup.

Sources: [`tiddle-continuity.mjs`](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/tiddle-continuity.mjs#L289-L298), [`working-memory-retention-settings.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/working-memory-retention-settings.mjs#L3-L25).

### Artifact attachment has source-visible exceptional paths

The Forge attachment rollback path references `path.join` without importing the path module. If the conversation write fails after the attachment file is created, cleanup can throw and leave the file behind. Verify attachment results and retained files separately from successful generation. The previously missing Albdruck original-message resolver is supplied in release `2026.10.02.7`; that earlier defect no longer applies to this baseline.

Source: [`postgres-forge-store.mjs`](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/backend/src/postgres-forge-store.mjs#L541-L562). This is a static error-path finding, not an executed failure test.

### Minion policy and completion evidence are narrower than parent state

The child tool runner builds a fresh execution context without forwarding the parent's `executionBoundaries`; the local process payload also omits the full parent execution context. Do not assume operator hard blocks or every parent-backed capability propagate to a minion. Limit the service account and execution host independently, and verify a required child restriction before delegating consequential work. This is a static trust-boundary finding, not a demonstrated isolation test.

Sources: [child context construction](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/subagent-worker-runner.mjs#L143-L164), [local/remote dispatch payloads](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/subagent-tool-executor.mjs#L314-L319).

A child's aggregate result initializes `changedFiles` and `memoryWrites` to empty and `sideEffectsApplied` to false even though its tools can mutate state. The local process runner has no timeout timer despite `timed_out` being an allowed record status. Inspect actual tool receipts and active state; do not treat these fields as proof of no effects or a guaranteed deadline. See [Agents and minions](../concepts/agents-minions.md#completion-and-evidence). Sources: [result projection](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/subagent-worker-runner.mjs#L324-L338), [process lifecycle](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/subagent-process-runner.mjs#L74-L145).

### Two exceptional runtime paths reference unavailable helpers

The non-JSON `continuity_uncertain` return references `compactAskChatResult`, and blocked final-prompt handling references `finalizeBlockedRuntimeResult`, without imports or definitions in the module. Entering those branches can raise a reference error instead of the intended structured result. Preserve the exact error and reconcile session/context evidence rather than repeatedly resubmitting work. This source inspection did not execute either failure path. Source: [`app-runtime.mjs`](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/app-runtime.mjs#L171-L184), [blocked-prompt branch](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/app-runtime.mjs#L388-L410).

## Security and observability cautions

- Workspace selection is not filesystem confinement; review [permissions](../security/permissions.md).
- The unauthenticated `/health` path exposes runtime status, not merely a Boolean. Restrict it at a reverse proxy when appropriate.
- Diagnostics tokens are read-only but can expose conversation, context, and trace content.
- Trace truncation is not universal secret redaction. Inspect evidence before sharing it.
- A container health result or successful model response does not prove an entire workflow completed.
- Context usage is an estimate, not an exact token-meter guarantee.

See [trust boundaries](../security/trust-boundaries.md), [observability](../operations/observability.md), and [troubleshooting](../operations/troubleshooting.md) for operational guidance.
