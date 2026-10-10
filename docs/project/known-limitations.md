# Known limitations

These observations were rechecked against release **2026.10.10.4**, the [documented source baseline](source-map.md). They describe published source and packaging, not an independently tested running installation. Recheck them when upgrading.

## Configuration and command compatibility

### `burrow.json` is not application configuration

The retained loader deliberately does not read JSON application configuration. Editing an old `burrow.json` does not configure the runtime. Use PostgreSQL-backed settings and the service environment described in [configuration](../reference/configuration.md).

Source: [configuration loader](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/config.mjs).

### Direct model CLI commands lack store wiring

The raw CLI resolves a model before dispatching `ask`, `chat`, `plan`, `run`, and `factory`, without supplying the model-settings store required by the resolver. These paths can fail with `model_settings_store_required`. The composed HTTP/UI chat path supplies its stores separately. `doctor` now uses the composed PostgreSQL application; the previous missing-store doctor caveat no longer applies. The obsolete `dream-memory` and `dream-cycle` command names are no longer accepted.

Sources: [CLI dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/bin/burrow.mjs), [model resolver](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/config.mjs), [doctor](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/doctor.mjs). See [CLI distinctions](../reference/cli.md).

### Public assembly omits Backend tests and API contract assets

The published tree does not contain `backend/tests/` or `backend/docs/`, although package scripts reference them. In particular, `openapi:check` cannot validate the absent contract/tests in this assembly. The old `runtime:restore:rehearsal` npm script has been removed.

The Scalar explorer reads `backend/docs/openapi.json`; its shell can load while the schema request fails. The [API reference](../reference/api.md) provides a historical source-pinned contract, not proof of current route/body/response parity. The literal-route drift checker is not a complete method or schema comparison. Report blocked checks explicitly; an npm script's existence does not prove it is runnable.

Sources: [package scripts](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/package.json), [API explorer](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L3303-L3308), [drift checker](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/check-openapi-route-drift.mjs).

## Installation, recovery, and retention

### Cold backup has explicit boundaries

`install-backup` does not stop the runtime or database for you. The current helper refuses managed PostgreSQL data outside the install root, symlinked data, an existing `postmaster.pid`, or a cluster not reported as cleanly shut down. It checks the cold policy before copying and again before publishing the archive. Stop the runtime and database, keep them stopped through the copy, and use a separate coordinated backup for external PostgreSQL and external filesystem paths.

Restore validates archive contents and checksums, rejects unsafe links, requires explicit mappings for retained absolute paths/database settings, and requires the original OS owner name and target UID for a managed physical archive. These checks do not make raw clusters portable across PostgreSQL major versions or platforms. Use the main `burrow install-restore --mapping-file ...` command; the standalone helper's argument parser does not accept that flag even though its restore function supports it. Follow [backup and recovery](../operations/backup-recovery.md).

Sources: [cold-copy and mapping policy](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/portable-backup-policy.mjs), [backup/restore implementation](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/portable-install-backup.mjs), [launcher CLI restore dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/bin/burrow.mjs#L326-L332).

### Diagnostic commands can initialize application schema

CLI helpers that construct the PostgreSQL application can apply pending migrations. They are not read-only merely because their output looks diagnostic. Take and verify a backup before running new-release CLI tools against an older production database.

Sources: [CLI application](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/cli-postgres.mjs), [PostgreSQL composition](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-composition.mjs).

### CLI retention uses a separate policy source

The `retention` CLI uses environment-derived policy, with default eligible-session ages of main 60 days, task 30 days, and subagent 7 days. It does not read the persisted UI trace policy. Preview targets with the same environment and explicit agent ID before confirming; `--summary` omits individual target paths. The historical flattened-metadata mismatch has been fixed: the planner reads `record.metadata || record`, checks terminal board-task eligibility, and rechecks eligibility before deletion. This source review did not execute production cleanup.

Sources: [CLI retention](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/cli-authority-commands.mjs), [policy defaults](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/config.mjs), [planner and deletion checks](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/retention.mjs). See [retention procedures](../operations/procedures.md#retention-maintenance).

## Setup and execution

### First-run profile set mismatch

The inspected first-run UI submits five profile documents, omitting `PREFERENCES`; the Backend complete-set validator still requires six. The durable setup operation now wraps its writes in a transaction, so the old claim that this necessarily leaves a partially created operator/agent does not apply. The set mismatch can still reject setup. See [initial setup](../getting-started/initial-setup.md) for the current recovery path; do not assume repeated retries change the payload.

Sources: [wizard payload](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/settings/AgentToolbar.tsx), [complete-set validator](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-agent-profile-store.mjs), [transactional setup](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/setup-operation.mjs).

### Verify terminal execution on the installed deployment

Scheduler dispatch now receives the composed stores, and task-board execution awaits asynchronous store lookups and execution updates. These historical wiring defects are resolved in the inspected source. This documentation update did not execute a real scheduled or task-board model turn. A dispatch acknowledgement still does not prove completion: inspect terminal run/task receipts and test a harmless job before relying on unattended work. See [workers and tasks](../concepts/workers-tasks.md).

Sources: [server composition and board execution](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs), [scheduled dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/scheduled-job-scheduler.mjs).

### Minion process lifecycle is not a guaranteed deadline

The local process runner supports abort-driven process-group termination with a grace period and forced kill. It does not install a wall-clock task timeout merely because `timed_out` is an allowed record status. Inspect active state and tool receipts. Child policy propagation and result aggregation have been revised: the historical missing `executionBoundaries` and unconditional empty/false completion-evidence claims no longer apply. This is source inspection, not a demonstrated isolation test; host permissions remain an independent boundary.

Sources: [process lifecycle](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/subagent-process-runner.mjs), [child dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/subagent-tool-executor.mjs), [child context and evidence](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/subagent-worker-runner.mjs). See [Agents and minions](../concepts/agents-minions.md#completion-and-evidence).

## Security and observability cautions

- Workspace selection is not filesystem confinement; review [permissions](../security/permissions.md).
- Both `/health` and `/api/health` return public readiness/build identity before authentication. They do not establish model or integration success.
- Diagnostics tokens are read-only but can expose conversation, context, and trace content.
- Trace truncation is not universal secret redaction. Inspect evidence before sharing it.
- A container health result or successful model response does not prove an entire workflow completed.
- Context usage is an estimate, not an exact token-meter guarantee.

Source: [health routing](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs#L3232-L3234). See [trust boundaries](../security/trust-boundaries.md), [observability](../operations/observability.md), and [troubleshooting](../operations/troubleshooting.md).
