# Tasks and schedules

This guide follows the public **2026.10.19** release. The **tasks** page records work and dispatches saved tasks. **Cron jobs** run agent prompts on a schedule. Creating a board record does not itself start agent work.

## Create a project

1. Open **tasks**.
2. Click **Manage projects**, then **Add project**. An empty board also has an **Add project** button.
3. Enter a project name. Add a description, shared **Project notes**, and optional **Named paths** with labels and notes.
4. Click **Add project** to save.

A project is required before you can create a task. Named paths help describe the project; they do not grant access, move the workspace, or prove that those paths currently exist.

[Source: project creation and fields](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/TasksPage.tsx#L160-L206) · [Source: project-context limits](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/scripts/burrow-ui.mjs#L271-L284)

## Create and organize a task

1. Click **New task**.
2. Enter its title and description.
3. Choose **Project**, **Priority**, **Status**, and an optional **Assignee**.
4. Click **Create task**.

The visible board columns are **Backlog**, **To Do**, **In Progress**, **Review**, and **Done**. To move a task, open its card, change **Status**, and click **Save changes**. Use the project selector and **Search tasks** to narrow the board. There is no drag-and-drop movement implemented in this board.

[Source: board columns and editing](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/TasksPage.tsx#L43-L49) · [Source: task form and board](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/TasksPage.tsx#L192-L207)

## Ask the assigned agent to execute it

1. Open a saved task and choose an agent if it is unassigned.
2. Click **Save changes** before executing. **Execute** uses the saved task, not the draft still in the form.
3. Reopen the task if necessary and click **Execute**.
4. Burrow opens the assigned agent's chat. Follow the response, tool activity, and reported blockers there.
5. Review the result and update the board status when appropriate.

Done or cancelled tasks cannot be executed. Dispatch runs in the assigned agent's **default** conversation, not a newly created task-specific session. Its project context applies to that run and does not replace the conversation's active project. The execution receipt records completion or failure separately from the board status; a completed run does not automatically move the card to Done.

[Source: Execute and unsaved-edit guard](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/TasksPage.tsx#L144-L157) · [Source: dispatch target and validation](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/scripts/burrow-ui.mjs#L271-L308) · [Source: execution receipt](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/postgres-task-board-store.mjs#L475-L505)

## Attach documents and review activity

After creating a task, open its card and use **Documents → Attach document**. Saved attachments have **Download** and **Remove** actions. Task document storage is distinct from chat attachment extraction; an uploaded document is not a promise that every format will be readable by the model.

The **History** section lists recorded changes, actors, times, and execution events. Use **Refresh history** for newer activity or **Load older activity** for earlier records. The board itself loads on entry; it does not continuously poll every task's execution state.

**Delete task** asks for confirmation. **Manage projects → Delete** deletes the project and all its tasks, so review that confirmation carefully.

[Source: task documents and history](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/TaskActivity.tsx#L27-L88) · [Source: board loading](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/TasksPage.tsx#L67-L84) · [Source: project deletion](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/TasksPage.tsx#L179-L188)

## Add project context to a chat

In a chat session, type `$project` to open the project picker and select a project. The selection is stored for that agent/session. Type `$project` again and choose **Clear active project** to remove it; `$project clear` also clears it. This supplies project context without executing a board task.

[Source: conversation project picker](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/chat/ChatComposer.tsx#L110-L161)

## Schedule a recurring prompt

1. Check **Settings → General → Operator timezone** first.
2. Open **Settings → Agents**, select an agent, and choose **Cron jobs**.
3. Enter **Name**, **Prompt**, and a five-field **Cron** expression in the order `minute hour day month weekday`. For example, `0 9 * * *` means daily at 09:00 in the operator timezone.
4. Keep **Use agent chat model**, or choose a model override for this job only.
5. Check **Enabled** and click **Add job**.

Select a saved job to edit it; click **Save job** after changing its prompt, schedule, model, or enabled state. An unavailable saved model override must be corrected or changed to inheritance; it does not silently fall back. **Run now** starts a background run. The “started” notice confirms acceptance, not completion.

Mod-owned jobs show **Managed by [mod]**. Edit them through that mod. The scheduler page lets you run them or open their details to delete them, but the mod may recreate a deleted job.

[Source: cron form, timezone, model override, and managed jobs](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/AgentSchedules.tsx#L57-L91)

## Work delegated to minions

An agent may spawn a minion for part of a request. The **Agents** panel lets you inspect child activity by expanding its parent and selecting the child. To choose a default minion model, open **Settings → Agents → [agent] → Agent details**, configure **Default minion provider/model**, and click **Save minion model**. Inheritance uses the current parent turn's model; an explicit model choice at spawn takes precedence.

[Source: child selection](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/App.tsx#L119-L132) · [Source: default minion model](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/DefaultMinionModel.tsx#L53-L71)
