# Common operational procedures

These recipes describe **2026.10.10.4** and assume the default native user installation. For containers, use the corresponding [container commands](containers.md). Replace example agent/session IDs with real values and run as the installation owner.

## Start, stop, inspect

```sh
"$HOME/.burrow/bin/burrow" service start
"$HOME/.burrow/bin/burrow" service status
"$HOME/.burrow/bin/burrow" service logs -n 100
```

For a deliberate restart:

```sh
"$HOME/.burrow/bin/burrow" service restart
curl -fsS http://127.0.0.1:42817/api/health
```

1. Check active conversations and task executions before restarting; stop or wait for consequential work to settle.
2. Run the restart and status commands, then check the health response and logs.
3. Confirm the reported version is the intended release and the UI loads the expected agent registry.

Shutdown records interruption evidence, but recovery is not a guarantee that external actions can safely be replayed. If health fails, inspect service logs and the configured listener before repeatedly restarting. If authentication is enabled, use the authenticated UI or an authorized client for protected health details; do not disable authentication to make a probe pass.

## Change listener settings

The installer owns the durable native host/port settings. Apply explicit values during installation or update:

```sh
"$HOME/.burrow/bin/burrow" update --host 127.0.0.1 --port 42817
```

This also performs the normal application update. It is not a settings-only operation. For a deployment that must retain its current app revision, review the existing environment and supervisor configuration using the [configuration reference](../reference/configuration.md), then make an operator-controlled settings change and restart.

Do not switch to `0.0.0.0` without reviewing [network exposure](deployment.md#network-exposure).

## Inspect a completed run

Run CLI readers as the installation owner using the installed launcher. Current readers resolve the configured PostgreSQL lifecycle and managed socket; do not copy database settings from another installation. See [managed reader connection](../reference/cli.md#managed-reader-connection).

```sh
"$HOME/.burrow/bin/burrow" trace \
  --agent-id assistant --run-id RUN_ID --json
"$HOME/.burrow/bin/burrow" session-search \
  --agent-id assistant --session-id default --query 'release decision' --json
```

Use an explicit run ID for incident investigation. `--latest` is useful for exploration but can select newer work than the incident being investigated. Keep tool-output/trace artifacts private until reviewed.

## Stop a chat

1. Open the intended agent and session; confirm the displayed run is the one to stop.
2. Choose **Stop response** (square icon) or send `/stop` in that conversation. Closing a tab is not cancellation.
3. Wait for active-run state to settle, then inspect the recorded tool activity and final/cancelled outcome.
4. Before retrying, verify any external changes already made. If **Could not stop run** appears, recheck the active run rather than assuming the request succeeded.

If the intent is to correct work rather than stop it, send a follow-up while the run is active. Confirm whether it is pending, delivered to the run, or retained as an undelivered follow-up. A pending steering message waits for a model boundary. Sources: [cancellation](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/chat/useChatRun.ts), [steering status](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/chat/ChatTranscript.tsx).

## Execute and verify a board task

1. Open **Tasks**, create a project if needed, and create or open a task.
2. Fill in the description and **Assignee**, then save. **Execute** uses only the saved task and rejects unsaved edits.
3. Choose **Execute** on a task that is neither Done nor cancelled. Expect a running execution receipt and the **Live execution** panel.
4. Follow progress; the UI polls active runs and reloads the task after execution ends. The assigned agent runs the task in its **default** conversation, with project context scoped to this task run.
5. Inspect the default conversation and **Archive → Proof** for its final answer, blockers, and verification. Update the board status to reflect the reviewed outcome.

The dispatch lookup is awaited in this release; the former unassigned-task warning is obsolete. Execution success does not automatically move a task to Done. A progress panel may remain visible during a transient status-poll failure. Check runtime activity and the task's persisted execution before retrying; a disconnected browser does not prove dispatch failed. Project paths supply context, not filesystem authorization. Sources: [task editor and polling](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/tasks/TasksPage.tsx), [task dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/burrow-ui.mjs), [receipt persistence](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-task-board-store.mjs).

## Recover a prior decision or saved memory

1. For an original conversation, open **Archive → Chat**, filter by agent and date or search text, and open the session.
2. Choose **Load earlier messages** until the relevant passage is available. **Copy loaded chat** copies only what has been loaded. A load error or **Earlier retained history is unavailable** is not the beginning of history; retry or restart from latest as offered.
3. Ask the owning agent to use `session_search` when you need historical decisions, reset snapshots, or an expanded original with neighboring messages. Check the returned date and source provenance.
4. For an explicit saved memory, open **Brains**, select **Agent owner**, and search. Open the entry to inspect its content, source references, origin, and revision.
5. To correct it, edit and choose **Save memory**. On a conflict, preserve your intended wording elsewhere, **Reload memory**, compare, and reapply only the desired correction.

Brains records are agent-owned saved context, not verification of current runtime state. Legacy migration details explain origin; they do not certify present truth. Brains does not provide the old global knowledge, Recall, or purge controls. Sources: [Archive reader](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/tasks/ArchiveReaders.tsx), [historical search](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/action-proposal.mjs), [Brains editor](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/albdruck/AlbdruckPage.tsx).

### Delete saved memories deliberately

1. Confirm the agent owner and exact memories. Save any recovery copy you require before deletion.
2. Use **Delete memory**, or check selected entries and use **Delete selected memories**. **Select page** affects only that page.
3. Inspect each bulk result: these are separate deletions, so some can succeed while others conflict or fail.
4. **Reload list** and review current revisions before retrying failed entries.

These controls delete immediately without a separate UI confirmation. Memory deletion does not delete conversation originals, attachments, browser caches, or other retained evidence. The legacy Albdruck conversation-purge route adapter is not mounted in this release; its historical procedure is not a supported erasure workflow. Sources: [delete behavior](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/albdruck/AlbdruckPage.tsx), [retired adapter](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/legacy-albdruck-routes.mjs).

## Retention maintenance

Use **Settings → General → Trace retention** for managed trace cleanup:

1. Take a recovery backup if traces may be needed for incident review.
2. Choose the maximum age and/or storage limit and a cadence between 15 minutes and 7 days. Enable managed cleanup only when those limits are intended.
3. Choose **Save policy**. Expect confirmation that the policy was saved.
4. Choose **Preview cleanup** and inspect the trace count and reclaimable bytes. The UI summarizes the plan; it does not display individual paths.
5. If the saved, previewed policy is still the intended one, choose **Run now**. Any form edit requires saving and previewing again.
6. Check the cleanup result, last-run status, next-run status, and any error. A zero count may simply mean no trace qualifies.

Managed cleanup is disabled until enabled with at least one limit. This surface removes trace data, not Brains records or a selected conversation. If a save/preview fails, resolve that error before proceeding. Do not use a different policy surface merely to bypass the guard. [Source: [retention controls](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/ui/src/features/settings/RetentionSettings.tsx)]

### CLI retention is a separate policy

The CLI reads environment/default retention values. It does **not** read the persisted Settings policy or its disabled flag. Defaults are 60 days for eligible main-kind sessions, 30 for task sessions, and 7 for subagent sessions; trace age/byte limits are unset unless configured. A disabled UI policy does not make CLI `--confirm` harmless.

With the correct database connection (use the managed subshell above when needed), preview the **full** target list:

```sh
"$HOME/.burrow/bin/burrow" retention --agent-id assistant --json
```

Do not use `--summary` as the only deletion review: it hides individual candidates. Only after inspecting this CLI-specific plan and a recovery backup should an operator deliberately add `--confirm` to the same invocation with unchanged inputs. Avoid adding duplicate cleanup timers alongside the runtime scheduler.

## Add a read-only database operator

For a running **managed** database, `postgres-access` creates dedicated SQL-reader roles. It requires the same OS owner and lifecycle environment as the server. This is privileged credential administration, not a harmless status check:

```sh
"$HOME/.burrow/bin/burrow" postgres-access list
```

With deliberate authorization, `create --name NAME`, `rotate --name NAME`, and `revoke --name NAME` administer those roles. Create/rotate prints the new password once in JSON. Capture it securely, never in shared logs. The role can read sensitive application tables; read-only access is still data access. See [CLI](../reference/cli.md#managed-postgresql-access).

## Remove the application

To remove the app and launcher while retaining durable state:

```sh
"$HOME/.burrow/bin/burrow" uninstall
```

Full removal also destroys the installation's durable state. Back up first, then use `uninstall --purge` only when that destruction is intended. Noninteractive uninstall requires explicit `--yes`. Container volume deletion is a separate destructive operation.

## Source evidence

- [Installed management launcher](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/install.sh)
- [CLI retention and trace dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/bin/burrow.mjs)
- [Managed operator access](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/managed-postgres-access.mjs)
- [Retention implementation](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/retention.mjs)

Additional implementation evidence: [CLI connection and retention policy resolution](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/cli-authority-commands.mjs), [retention environment defaults](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/config.mjs).
