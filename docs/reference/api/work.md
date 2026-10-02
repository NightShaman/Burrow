# Tasks, schedules and groups

BURROW exposes several work surfaces with different state models. The task board, scheduled jobs, group channels and retained Workbench compatibility API are not interchangeable task queues.

## Task board

Create a project with `{name}`. Create a task with at least `projectId` and `title`; optional state, priority, description and assigned-agent fields are validated by the store. Read available statuses/priorities rather than inventing identifiers. List filters are `projectId`, `status`, `priority` and `assignedAgentId`.

`POST /api/task-board/tasks/{id}/execute` is intended to launch work through the assigned agent. The current controller calls asynchronous task/project lookups without awaiting them, so it can reject a normal task as unassigned. Verify the outcome and consult [known limitations](../../project/known-limitations.md). Its response is not final task completion, and execution does not automatically move the task through board columns. The current UI shows five columns and creates tasks in To Do; the API/store default is Backlog.

A conversation can bind an active project. GET/DELETE use `agentId` and optional `sessionId` (default `default`); PUT additionally requires `projectId`. The binding supports continuity and task context, not filesystem confinement.

[Task routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/task-board-routes.mjs#L1-L101) · [Task semantics](../../concepts/workers-tasks.md)

## Scheduled jobs

Create requires nonblank `agentId`, `name`, `prompt` and a five-field `cron` expression; timezone and model selection are separate stored settings. List can filter `agentId` and `enabled`. Job detail, PATCH, DELETE and run history use the job ID; run history accepts `limit`.

`POST /api/scheduled-jobs/{jobId}/trigger` returns 202 admission. Inspect run history for terminal outcome. To cancel an active run, POST its `/runs/{runId}/cancel` path with optional `reason`; a non-active run returns 404. Cancellation does not undo completed tools.

!!! warning "Validate execution, not only scheduling"
    The documented baseline has a source-visible default scheduler/store-wiring gap. Saving a cron job or receiving a trigger acknowledgement does not establish successful unattended execution. Inspect [known limitations](../../project/known-limitations.md#scheduled-execution-wiring-requires-validation) and terminal receipts before relying on it.

[Schedule routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/scheduled-channel-routes.mjs#L1-L14)

## Group channels

Create with `name` and a nonempty `participantAgentIds` array. The browser asks for at least two agents; the server boundary permits a nonempty participant list. Read channel detail for up to 500 turns plus active runs.

POST messages with `message` and optional `agentIds`. Explicit targets win; otherwise recognized `@` mentions select participants; without targets/mentions the message is broadcast. Unknown mentions fail validation. The server launches private per-agent `group-<channelId>` sessions and returns 202 with run IDs. Participants keep their own identity, tools and memory scope while receiving shared room context; the visible transcript is not a single merged agent identity.

Cancel through the group run endpoint. Poll detail for final visible messages; there is no group NDJSON contract here.

[Group routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/scheduled-channel-routes.mjs#L15-L26) · [Targeting/launch](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L3009-L3068)

## Legacy Workbench compatibility

`/api/tasks` and `/api/workbench` remain isolated compatibility routes for work items and planning/step/continuation. They are distinct from `/api/task-board/tasks`, the current Tasks UI and Minion execution. Do not build new task-board clients by treating the names as aliases.

[Compatibility route module](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/workbench-routes.mjs#L1-L65)


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
| `GET` | `/api/task-board/conversation-project` | Get the conversation active project |
| `PUT` | `/api/task-board/conversation-project` | Set the conversation active project |
| `DELETE` | `/api/task-board/conversation-project` | Clear the conversation active project |
