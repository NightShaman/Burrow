# Everyday use

The original guide follows public **2026.10.19**. Its source links remain pinned to that historical release; dated additions describe current implementation.

## Find your way around

The main navigation contains **chat**, **tasks**, **archive**, **Brains**, **Forge**, and **settings**. Enabled mods can add their own pages. In chat, side panels can show agents, workspace files, account status, or system information. Change those panels under **Settings → General → Rail panels**; change the theme under **Appearance**.

[Source: main navigation](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/App.tsx#L192-L223) · [Source: settings sections](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/SettingsPage.tsx#L88-L167)

## Talk to an agent

1. Open **chat** and select the agent in the **Agents** panel.
2. Check the **Provider**, **Model**, and **Effort** controls above the conversation. These use your saved model connections. The toolbar is locked while the displayed run is active.
3. Type a message and press **Enter** or click **Send message**. Use **Shift+Enter** for a new line.
4. Watch the response and tool activity. Use **Stop response** to request cancellation. When the active run accepts steering, you can send a further instruction while it works; otherwise sending is temporarily disabled.

A useful first request is specific about the result and location: “Inspect /srv/projects/example and summarize its test setup. Do not change files.” The agent's workspace is on the machine running Burrow or its assigned execution provider, not automatically on the computer displaying the web page.

[Source: chat controls and steering](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/chat/ChatPage.tsx#L17-L131) · [Source: composer keys and buttons](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/chat/ChatComposer.tsx#L211-L221)

### Attach material

Use the paperclip, drag files into the composer, or paste an image. Review the attachment chips before sending; click one to remove it. Chat accepts images and supported text/code documents. **PDF extraction is not supported.** The default browser limits are 8 files, 8 MiB per file, and 16 MiB combined; deployments can override these browser budgets, and server limits may also apply.

[Source: supported attachments](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/App.tsx#L29) · [Source: attachment validation](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/App.tsx#L160-L169) · [Source: browser budgets](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/app/clientBudgets.ts#L1-L37)

### Current session-routing controls

Checked **24 October 2026**: the chat toolbar includes **A2A in default**, a per-agent toggle for incoming agent-to-agent conversation routing. Enabled is the default; turning it off routes new implicit A2A deliveries to that agent's separate `a2a` session, displayed as **A2A**. Explicit target sessions and runtime-attested replies keep their existing routes; an exchange already in flight is not redirected. This is a routing preference, not a deletion or migration of existing conversations. Refresh/select the intended session to inspect its history.

Switchboard sessions receive readable Telegram/Discord labels in the session selector while retaining their actual session IDs. A label alone does not establish that the corresponding transport is configured or healthy; use the mod's own status and mapping controls.

Implementation: `ChatPage.tsx` and the Core agent context configuration; current source pins are in [release coverage](../project/release-status.md).

### Choose a session

- **New session** creates a named session. Enter a name and click **Create session**.
- The **Session** selector returns to an existing session for the selected agent.
- **Reset Session** starts a fresh generation of the current session. Prior history is archived, not erased.
- **Group Chat** opens existing rooms or creates a room with a name and selected agent participants. In a group composer, type `@` to choose an agent mention.

Type `/help` to see chat commands. The composer also offers `/context`, `/context full`, `/status`, `/new`, and `/stop`. Selecting a command fills the composer; send it to run it.

[Source: session and group dialogs](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/chat/ChatComposerDialogs.tsx#L30-L60) · [Source: reset result](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/scripts/burrow-ui.mjs#L2625-L2626) · [Source: commands](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/chat/ChatComposer.tsx#L8-L14) · [Source: group mentions](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/groups/GroupChannelsPage.tsx#L122-L147)

### If a run appears stuck

Use **Stop response**, then check the run's terminal status and reload the persisted transcript before retrying the request. Reset preserves archives but changes the active conversation generation; avoid treating it as a routine retry button while an important write may still be running.

Newer Core/UI code reviewed on 21 October adds cancellation deadlines, reset-generation fencing and terminal transcript reconciliation. These are not part of the inspected public 2026.10.19 snapshot. They do not undo an external side effect already completed before cancellation. See [release status](../project/release-status.md).

## Read and edit workspace files

In chat, open a file from the **Workspace** panel. It opens in a document tab. Click **Edit**, make your changes, then **Save**. Closing a modified file tab asks whether to discard unsaved edits. Saving writes to that tab's agent workspace; changing the selected agent does not retarget an already-open file tab.

[Source: workspace file ownership and saves](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/workspace/useWorkspaceFiles.ts#L27-L55) · [Source: file editor](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/chat/ChatPage.tsx#L135-L153) · [Source: discard prompt](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/App.tsx#L139-L140)

## Find earlier work

Open **archive** and choose **Chat**, **Dreams**, **Tiddle**, or **Proof**. Use search and the agent filter. Chat and Dreams support calendar browsing in your browser's local timezone. **Proof** shows recorded run outcomes and evidence; an old successful run does not verify today's filesystem or service state. The **Copy conversation** button in chat copies the displayed transcript as Markdown.

[Source: Archive](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/ArchivePage.tsx#L13-L18) · [Source: archive filters](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/tasks/ArchivePage.tsx#L67-L92) · [Source: historical evidence scope](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/action-proposal.mjs#L230-L231)

## Generate media in Forge

1. Open **Forge** and choose **Image**, **Speech**, or **Music**.
2. Select an available model, enter a prompt or speech script, and click **Generate**. Generation uses your configured provider and may incur its charges.
3. Check the job's status. When it succeeds, preview or **Download** the output. **Attach to conversation** adds it to the selected chat session.
4. Use **Recents** to revisit earlier jobs and **Refresh** if needed.

Model availability depends on your connections. This release has no video provider contract; the Video tab is not a promise of working video generation. Source attachments and provider-specific tuning are also unsupported by the current Forge contract. The animated pressure gauge is decorative, not progress.

[Source: Forge workflow and limitations](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/forge/ForgePage.tsx#L240-L266) · [Source: generation contract](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/forge-agent-tools.mjs#L26-L30)

Next: [Tools and mods](tools-and-mods.md), [Skills and memory](skills-and-memory.md), or [Tasks and schedules](tasks.md).
