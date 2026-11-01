# Tasks and schedules

Current implementation reviewed **1 November 2026**. [Source coverage](../project/source-map.md) records the exact build and verification limits. Existing commit-linked citations identify historical evidence; they are not links to the current development source.

The **tasks** page records work and dispatches saved tasks. **Cron jobs** schedule prompts or saved board tasks, either recurring or once. Creating a board record does not itself start agent work.

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

Use **Documents → Attach document** while creating a task or after opening its saved card. For a new task, files upload after the task record is created. If an upload fails, the task remains saved and **Save changes** retries the remaining files; do not create another task just to retry attachments. Saved attachments have **Download** and **Remove** actions. Task document storage is distinct from chat attachment extraction; an uploaded document is not a promise that every format will be readable by the model.

The **History** section lists recorded changes, actors, times, and execution events. Use **Refresh history** for newer activity or **Load older activity** for earlier records. The board loads on entry and refreshes its task list about every 60 seconds, including archive eligibility. This is not live execution streaming; task-history paging is separate.

**Delete task** asks for confirmation. **Manage projects → Delete** deletes the project and all its tasks, so review that confirmation carefully.

[Source: task documents and history](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/TaskActivity.tsx#L27-L88) · [Source: board loading](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/TasksPage.tsx#L67-L84) · [Source: project deletion](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/TasksPage.tsx#L179-L188)

## Completed tasks move to Archive

A **Done** task leaves the active board after 48 hours and appears under **Archive → Tasks**. This is a reversible view, not deletion or a new task status. Editing its title, description, priority, or assignee does not restart the completion clock. **Reopen task** changes it to To Do and returns it to the board. Archived task details keep history and documents available read-only. Cancelled tasks do not enter this Done-only archive automatically.

## Add project context to a chat

In a chat session, type `$project` to open the project picker and select a project. The selection is stored for that agent/session. Type `$project` again and choose **Clear active project** to remove it; `$project clear` also clears it. This supplies project context without executing a board task.

[Source: conversation project picker](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/chat/ChatComposer.tsx#L110-L161)

## Schedule a recurring prompt

1. Check **Settings → General → Operator profile → Operator timezone** first.
2. Open **Settings → Agents**, select an agent, and choose **Cron jobs**.
3. Select **Run → Prompt** and **Schedule → Recurring**. Enter **Name**, **Prompt**, and a five-field **Cron** expression in the order `minute hour day month weekday`. For example, `0 9 * * *` means daily at 09:00 in the operator timezone.
4. Keep **Use agent chat model**, or choose a model override for this job only.
5. Check **Enabled** and click **Add job**.

Select a saved job to edit it; click **Save job** after changing its prompt, schedule, model, or enabled state. An unavailable saved model override must be corrected or changed to inheritance; it does not silently fall back. **Run now** starts a background run. The “started” notice confirms acceptance, not completion.

Mod-owned jobs show **Managed by [mod]**. Edit them through that mod. The scheduler page lets you run them or open their details to delete them, but the mod may recreate a deleted job.

[Source: cron form, timezone, model override, and managed jobs](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/AgentSchedules.tsx#L57-L91)

## Schedule a saved board task or a one-time run

In the same **Cron jobs** editor:

1. For existing work, select **Run → Board task** and choose a saved **To Do** task assigned to this agent. Tasks are grouped by project. Save changes to the task itself before scheduling it.
2. Add optional **Extra instructions**. These supplement the task's saved title, description and project context; they do not replace its instructions or copy an unsaved board draft.
3. Choose **Schedule → Recurring** with a cron expression, or **Once** with a future **Run at** time in the displayed **Operator timezone**. The section is still called Cron jobs even for a one-time job.
4. Review the model choice and **Enabled**, then choose **Add job** or **Save job**. **Refresh jobs** reloads the inventory and task eligibility; **Retry tasks** or **Retry timezone** addresses those separate load failures.

A task job always executes in the assigned agent's **default** conversation, continuing that context. Eligibility is checked again at dispatch. A missing, reassigned, archived, or non-To-Do task is **skipped**, with a durable receipt and no task-status change. Keeping an existing now-ineligible target allows you to pause or edit its schedule; it does not make the task executable. Ordinary manual **Execute** has different eligibility: it excludes Done/cancelled rather than requiring To Do.

A **Once** job is consumed and disabled by its due occurrence **or Run now**, even when its task is skipped. It does not remain armed for the original date after manual execution. Missed downtime occurrences are recorded as missed, not replayed. Recurring schedules are fixed cron expressions; this editor has no random interval or jitter option.

The **Saved jobs** inventory shows next time and last outcome, including skipped/missed, with **Open chat** when a run has usable chat evidence. “Started” means background admission, not completion. A task run is instructed to move work to In Progress and then Review; the operator owns the final Done decision. Inspect the board and run receipt rather than assuming the schedule updated the status successfully.

Changing a guarded settings draft or moving away can offer **Save**, **Discard**, or **Stay**. A save error keeps you in the editor; do not treat navigation as proof of persistence.

## Run an instruction when a GitHub workflow finishes

This is an inbound trigger for normal agent work, not an outbound GitHub integration or a new grant of repository permissions.

1. Open **Settings → Agents → [agent] → Workflow events**. In **Webhook receiver · global** below the watch editor, enter a high-entropy **Webhook secret** and choose **Save receiver**. The receiver is shared by every agent's watches. Optionally record a **Delivery URL** such as `https://burrow.example.test/api/events/github`; it must have that exact path and no query, fragment or embedded credentials. This field is metadata, not ingress configuration or a connectivity test.
2. In the source GitHub repository's **Settings → Webhooks → Add webhook**, use the same full public HTTPS URL, `application/json`, and the same secret. Select **Workflow runs** (`workflow_run`) and enable the webhook. Repository webhook creation requires the appropriate owner/admin access; see [GitHub's webhook instructions](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks). Burrow consumes completed workflow runs, not every GitHub event.
3. In the agent's watch form, enter **Repository** as `owner/repo`, the exact case-sensitive **Workflow name** (the displayed workflow name, not its YAML filename), **Destination session**, and an operator-written **Instruction**. A dedicated session such as the default `ci-releases` keeps this stream separate. Keep **Enabled** checked and choose **Add watch**. Watches require an enabled agent and use its ordinary chat model.
4. Open **Archive → Workflow Events** to inspect retained deliveries. **GitHub** conclusion describes CI; **Burrow handling** describes the triggered agent turn. Open the destination session and inspect actual run/trace evidence before calling the work complete.

An example standing instruction is: “Review the completed run and report verified results and blockers; do not change the repository without separate authorization.” Write the scope you actually intend. Webhook payloads/logs are evidence to inspect, not new operator instructions or additional permissions. Existing tools and agent grants still govern execution.

The global secret is encrypted and write-only: blank preserves it; **Clear stored secret on save** removes only the saved value. Optional `BURROW_GITHUB_WEBHOOK_SECRET` overrides it; the form shows that source. UI saves apply without restart, while an environment change requires a process restart. **Signature verification: Ready** means local receiver readiness only, not proven public delivery or agent completion. A missing/unavailable secret rejects deliveries; do not put a UI API token in the webhook secret field.

Signed ping is acknowledged without creating work. Accepted completed events are durable; HTTP 202 is acceptance, not success. Matching requires an enabled repository/workflow watch. Duplicate deliveries for the same repository/run/attempt/watch do not start a second execution; a new attempt is distinct. The saved event retains its standing instruction snapshot. Disabling/deleting a watch does not erase already accepted events. Interrupted processing is recorded rather than blindly replayed; inspect it before authorizing replacement work. Management routes and event details use ordinary operator authentication; the inbound webhook uses its separate signature check. See [work APIs](../reference/api/work.md) for client contracts.

## Work delegated to minions

An agent may spawn a minion for part of a request. The **Agents** panel lets you inspect child activity by expanding its parent and selecting the child. To choose a default minion model, open **Settings → Agents → [agent] → Agent details**, use **Minion settings** in the additional-settings column to configure **Default minion provider/model**. Complete model selections and supported thinking/effort choices autosave; temperature saves when adjustment ends. Check saved feedback and use the displayed retry action after a failure. Inheritance uses the current parent turn's model; an explicit model choice at spawn takes precedence.

[Source: child selection](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/App.tsx#L119-L132) · [Source: default minion model](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/DefaultMinionModel.tsx#L53-L71)

## Retained workflow delivery history

Open **Archive → Workflow Events** to search retained GitHub workflow deliveries and inspect their GitHub conclusion separately from Burrow handling state, result/error and chat run. Use the agent/date filters and local-time calendar. Accepted delivery does not prove the instruction completed. Settings → Agents → Workflow events retains watch and receiver configuration; its former Recent events history has moved to Archive. Review retained instruction/error text before sharing it, even when result fields are redacted.
