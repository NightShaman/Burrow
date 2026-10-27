# Tasks, schedules and groups


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-10-25**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


BURROW exposes several work surfaces with different state models. The task board, scheduled jobs, group channels and retained Workbench compatibility API are not interchangeable task queues.

## Task board

Create a project with `{name}`. Create a task with at least `projectId` and `title`; optional state, priority, description and assigned-agent fields are validated by the store. Read available statuses/priorities rather than inventing identifiers. List filters are `projectId`, `status`, `priority` and `assignedAgentId`.

`POST /api/task-board/tasks/{id}/execute` launches work through the assigned agent after awaiting the task/project lookups and execution record. Verify the returned outcome and then inspect the terminal execution receipt. Its response is not final task completion, and execution does not automatically move the task through board columns. The current UI shows five columns and creates tasks in To Do; the API/store default is Backlog.

Task responses also expose derived `archived` and `archivedAt`. A task in `done` becomes archived after 48 hours from its terminal timestamp (with updated/created fallback for old records). This is a reversible completion projection, not a new status, deletion or expiry of history. Changing out of Done clears that projection; unchanged Done edits preserve the completion boundary. List responses still carry these fields so clients can separate active and archived work.

Task history is available through `GET /api/task-board/tasks/{taskId}/history` with `limit` and `before`. Task document attachments have separate list/upload/download/delete endpoints; their bytes and audit metadata are stored in PostgreSQL. These are distinct from chat attachment artifacts.

A conversation can bind an active project. GET/DELETE use `agentId` and optional `sessionId` (default `default`); PUT additionally requires `projectId`. The binding supports continuity and task context, not filesystem confinement.
See [Task semantics](../../concepts/workers-tasks.md)

## Scheduled jobs

Create requires nonblank `agentId`, `name`, `prompt` and a five-field `cron` expression. Optional explicit model overrides use a complete `modelConnectionId`/`model` pair. New jobs are disabled unless `enabled: true` is supplied. Scheduling uses the operator timezone; legacy per-job timezone input is not authoritative. List can filter `agentId` and `enabled`. Job detail, PATCH, DELETE and run history use the job ID; run history accepts `limit`.

The API accepts `contextMode: "continue"` (default) or `"fresh"`. Fresh mode requires an explicit named `sessionId`, not `default`; invalid values are rejected. This backend setting is not a promise of a matching control in the current cron editor.

`POST /api/scheduled-jobs/{jobId}/trigger` returns 202 admission. Inspect run history for terminal outcome. To cancel an active run, POST its `/runs/{runId}/cancel` path with optional `reason`; a non-active run returns 404. Cancellation does not undo completed tools.


!!! warning "Validate execution, not only scheduling"
    The current scheduler receives the composed stores; the old missing-store wiring defect is resolved. Saving a cron job or receiving a trigger acknowledgement still does not establish successful unattended execution. Inspect terminal receipts and try a harmless job before relying on it.


## GitHub workflow completion events

This is a distinct durable inbound trigger for ordinary agent execution. The standing watch instruction and existing agent grants authorize the work; webhook text/logs/artifacts are evidence, not fresh authority. It is not an outbound GitHub credential or automatic permission to modify repositories.

| Method | Path | Purpose |
|---|---|---|
| `GET`, `POST` | `/api/events/settings` | Read/patch receiver configuration through normal UI authentication |
| `GET`, `POST` | `/api/events/watches` | List or create/update watches through normal UI authentication |
| `DELETE` | `/api/events/watches/{id}` | Delete a watch; accepted event snapshots remain |
| `GET` | `/api/events` | Retained event rows; optional agent filter and limit (default 50, maximum 500) |
| `POST` | `/api/events/github` | HMAC-authenticated GitHub `workflow_run` receiver, not UI-token authentication |

Receiver POST partially patches `deliveryUrl`, `secret`, and `clearSecret`. Omission preserves values; blank secret preserves stored bytes; `clearSecret: true` clears only the stored secret and cannot accompany a nonblank replacement. Secrets are encrypted/write-only, at most 8192 UTF-8 bytes with no CR/LF/NUL. Optional `BURROW_GITHUB_WEBHOOK_SECRET` overrides the stored value. Reads report source/override/configured/readiness flags, never plaintext. Readiness only establishes local signature-verification readiness, not public connectivity or a successful agent run.

A delivery URL is optional metadata, not routing configuration: it must be HTTP(S), path exactly `/api/events/github`, with no credentials/query/fragment. Configure the actual GitHub webhook separately with `application/json`, the same secret and **Workflow runs** events. Stored settings take effect per request; changed process environment needs restart.

Watch POST takes `repository: "owner/repo"`, exact case-sensitive workflow **name** (not YAML filename), enabled `agentId`, operator-written `instruction`, optional `sessionId` (default `ci-releases`) and `enabled` (default true). Omit `id` to create a UUID; provide it to update. Use a dedicated session when this work should not mix with ordinary chat.

The receiver verifies `X-Hub-Signature-256` over exact raw bytes, with a 256 KiB ceiling. Missing effective secret returns 503; invalid signature 401; oversize body 413. Signed ping returns 200; irrelevant events/actions return 202 with no accepted entries. Completed workflow deliveries must match validated repository/run/workflow identities and enabled watches.

A 202 receipt is durable acceptance, not agent success. It returns only accepted/duplicate counts and `{id, accepted}` per watch. Deduplication binds repository, run ID, attempt and watch ID; a distinct attempt is new work, conflicting snapshots return 409. States progress from pending to running and succeeded/failed; owner interruption remains inspectable rather than blindly rerunning side effects. Read retained events and terminal evidence to establish completion. Management responses can include operator instructions and execution details; keep them private.

## Group channels

Create with `name` and a nonempty `participantAgentIds` array. The browser asks for at least two agents; the server boundary permits a nonempty participant list. Read channel detail for up to 500 turns plus active runs.

POST messages with `message` and optional `agentIds`. Explicit targets win; otherwise recognized `@` mentions select participants; without targets/mentions the message is broadcast. Unknown mentions fail validation. The server launches private per-agent `group-<channelId>` sessions and returns 202 with run IDs. Participants keep their own identity, tools and memory scope while receiving shared room context; the visible transcript is not a single merged agent identity.

Cancel through the group run endpoint. Poll detail for final visible messages; there is no group NDJSON contract here.
## Legacy Workbench compatibility

`/api/tasks` and `/api/workbench` remain isolated compatibility routes for work items and planning/step/continuation. They are distinct from `/api/task-board/tasks`, the current Tasks UI and Minion execution. Do not build new task-board clients by treating the names as aliases.

## Endpoint inventory

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/task-board/statuses` | List task statuses |
| `GET` | `/api/task-board/priorities` | List task priorities |
| `GET` | `/api/task-board/projects` | List projects |
| `POST` | `/api/task-board/projects` | Create a project |
| `GET` | `/api/task-board/tasks` | List tasks |
| `POST` | `/api/task-board/tasks` | Create a task |
| `GET` | `/api/tasks` | List work items |
| `POST` | `/api/tasks` | Create a work item |
| `GET` | `/api/tasks/{id}` | Read a work item |
| `POST` | `/api/tasks/{id}/step` | Run one work-item step |
| `POST` | `/api/tasks/{id}/continue` | Continue a work item |
| `POST` | `/api/tasks/{id}/archive` | Archive a work item |
| `POST` | `/api/workbench` | Plan a workbench turn |
| `POST` | `/api/workbench/run` | Run a workbench step |
| `GET` | `/api/scheduled-jobs` | List scheduled jobs |
| `POST` | `/api/scheduled-jobs` | Create a scheduled job |
| `GET` | `/api/scheduled-jobs/{jobId}` | Read a scheduled job |
| `PATCH` | `/api/scheduled-jobs/{jobId}` | Update a scheduled job |
| `DELETE` | `/api/scheduled-jobs/{jobId}` | Delete a scheduled job |
| `GET` | `/api/scheduled-jobs/{jobId}/runs` | List scheduled job runs |
| `POST` | `/api/scheduled-jobs/{jobId}/trigger` | Trigger a scheduled job |
| `GET` | `/api/group-channels` | List group channels |
| `POST` | `/api/group-channels` | Create a group channel |
| `GET` | `/api/group-channels/{channelId}` | Read a group channel |
| `POST` | `/api/group-channels/{channelId}/messages` | Post a group-channel message |
| `POST` | `/api/group-channels/{channelId}/runs/{runId}/cancel` | Cancel a group-channel run |
| `POST` | `/api/task-board/tasks/{id}/execute` | Execute task-board task |
| `POST` | `/api/scheduled-jobs/{jobId}/runs/{runId}/cancel` | Cancel scheduled job run |
| `PATCH` | `/api/task-board/projects/{projectId}` | Update task-board project |
| `DELETE` | `/api/task-board/projects/{projectId}` | Delete task-board project |
| `GET` | `/api/task-board/tasks/{taskId}` | Read task-board task |
| `PATCH` | `/api/task-board/tasks/{taskId}` | Update task-board task |
| `DELETE` | `/api/task-board/tasks/{taskId}` | Delete task-board task |
| `GET` | `/api/task-board/tasks/{taskId}/history` | Read task audit history |
| `GET` | `/api/task-board/tasks/{taskId}/attachments` | List task document attachments |
| `POST` | `/api/task-board/tasks/{taskId}/attachments` | Upload a task document attachment |
| `GET` | `/api/task-board/tasks/{taskId}/attachments/{attachmentId}` | Download task document bytes |
| `DELETE` | `/api/task-board/tasks/{taskId}/attachments/{attachmentId}` | Delete a task document attachment |
| `GET` | `/api/task-board/conversation-project` | Get the conversation active project |
| `PUT` | `/api/task-board/conversation-project` | Set the conversation active project |
| `DELETE` | `/api/task-board/conversation-project` | Clear the conversation active project |

## Targeted source review

The full page was reconciled on **2026-10-25** against Backend commit `3bf50374d3601c821e787912d52b9044eaf649ec`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/scripts/ui/task-board-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/task-board-routes.mjs)
- [backend/src/postgres-task-audit-schema.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/postgres-task-audit-schema.mjs)
- [backend/src/postgres-scheduled-job-store.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/postgres-scheduled-job-store.mjs)

## 26 October delta review

Updated against Backend `4df4b424e2b2856cb2c25c8464da7f806eb661e0` on **2026-10-26**. This is a focused source comparison since the full review above, not a new application or provider test pass.

## 27 October delta review

Changed contracts checked statically against Backend `32ff99dfc0317635f5c7aa53b4c9ec18266d4c09` on **2026-10-27**. This does not recertify unchanged historical sections or report live API/provider tests.
