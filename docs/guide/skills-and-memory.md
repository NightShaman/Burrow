# Skills and memory

Current implementation delta reviewed **27 October 2026**. [Source coverage](../project/source-map.md) records the exact build and verification limits. Existing commit-linked citations identify historical evidence; they are not links to the current development source.

Use **skills** for reusable instructions, **profile documents** for agent-specific guidance, and **Brains** for explicit saved memories.

Burrow automatically provisions its runtime skill and adopts its official update source by default. Bundled and Git-managed instructions are read-only; creating a text skill is for your own optional instructions. Meet Tinker and Trixie and inspect the public instructions in [Burrow Skills](https://burrow-docs.blissful-psychosis.com/burrow-skills/). The [managed-skills guide](https://burrow-docs.blissful-psychosis.com/burrow-skills/managed-skills/) distinguishes the historical 2026.10.19 runtime from the implemented Core/mod-managed catalog.

## Official managed skills

Burrow's official operating skills have their own [repository and user guide](https://burrow-docs.blissful-psychosis.com/burrow-skills/). Read the source instructions and companion files before trusting them. Repository visibility helps inspection; it does not certify that a skill is safe.

The historical 2026.10.19 runtime adopted the official `burrow-runtime` Git source automatically. Current Core supplies Core and loaded mods' declared skills automatically from a dedicated read-only catalog, synchronizes at startup and mod lifecycle changes, and checks again every six hours by default. These managed copies are not edited or individually assigned through the ordinary skill editor. Customize a separate operator-owned skill instead.

The manual and Git-import controls below describe ordinary operator-managed skills. See [release status](../project/release-status.md) before expecting the newer mod-managed catalog on an older Core.

## Create a text skill

1. Open **Settings → Skills → New text skill**.
2. Fill in **ID**, **Name**, **Description**, and **Content**. Alternatively, click **Choose text file** to load a `.md`, `.markdown`, or `.txt` file into the form for review.
3. Choose a **Lifecycle**: available, experimental, deprecated, or disabled.
4. Check **Assign globally** if every agent should have access, or leave it unchecked for individual assignment.
5. Click **Create skill**. Loading a file into the editor does not save it until this step.

To assign a saved skill, open **Installed skills**, select it, and use its **Assignments** section. You can also open **Settings → Agents → [agent] → Skills** and check individual assignments. Assignments refer to the same shared skill; they do not create separate copies. A global skill cannot be individually unchecked in the agent view.

Use **Installed skills** to search by name, ID, or description, filter by lifecycle/assignment, edit operator-managed instructions, or delete a skill. Deletion removes the shared copy and its assignments.

[Source: text creation and assignments](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/SkillsSettings.tsx#L70-L153)

## Import a repository skill

1. Open **Settings → Skills → Import from repository**.
2. Enter the repository and **Skill path**. Select a directory for a package with companion files, or `SKILL.md` for instructions only.
3. Under **Ref & automatic updates**, choose a ref if needed. `HEAD` uses the repository default; tags and commit IDs stay pinned. Automatic sync is off unless enabled.
4. Click **Preview skill**. Read the actual instructions, included files, and previewed revision.
5. Review **Install ID & availability**, then click **Install skill**.
6. Assign it to the intended agents if you did not assign it globally.

The interface installs files; it does not execute package files during import. If the repository changes after preview, preview again before installing. If an install response times out, reload the library to check whether it completed before retrying.

[Source: repository preview and import](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/SkillRepositoryImport.tsx#L20-L76)

### Update an imported skill

Select it under **Installed skills**. Its **Source** section controls the repository, ref, path, and automatic sync schedule. **Save source** saves that configuration; **Sync now** fetches the upstream content. **Refresh status** checks an ongoing or uncertain result. Schedules use the operator timezone.

Upstream-managed instructions are read-only in the editor; lifecycle and assignments remain editable. Disabling automatic sync retains the installed content. A text-only source can be removed while retaining its text and assignments. A package with companion files cannot be detached here without copying; disable automatic sync instead. Private HTTPS credentials are not configured in this skill form.

[Source: source controls and limitations](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/SkillSourceSettings.tsx#L45-L75)

### What assigning a skill does

Assignment makes the skill available for discovery. It does not inject the full instructions into every prompt or guarantee that a particular turn uses them. The agent can list skills and explicitly load the relevant one. The planner does not automatically select full skill bodies. A disabled skill is unavailable; experimental and deprecated are lifecycle labels, not equivalent to disabled.

[Source: explicit loading](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/prompt-skill-selection.mjs#L5-L32) · [Source: lifecycle availability](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/skill-catalog.mjs#L21-L26) · [Source: skill discovery and load](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/skill-tool-executor.mjs#L5-L17)

## Edit an agent's profile documents

Open **Settings → Agents**, choose the agent, then **Profile documents**. Select **SOUL.md**, **RULES.md**, **ORIENTATION.md**, **PREFERENCES.md**, **TOOLS.md**, or **DreamMemory.md**. Edit the Markdown and click **Save profile documents**.

In current Core, **Settings → Agents → Global → Global documents** also provides Global Rules and Global Orientation. Each agent independently opts in through **Include Global Rules** and **Include Global Orientation**; included global text comes first, followed by that agent's local text. Both are off by default for existing agents.

These are agent guidance documents. Writing a permission into a document does not create an operating-system sandbox or an MCP grant; configure actual access separately in [Tools and mods](tools-and-mods.md).

[Source: profile document editor](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/AgentProfileDocuments.tsx#L6-L52)

## Create and correct saved memories

1. Open **Brains** and select the **Agent owner**.
2. Click **New memory**.
3. Add a **Title**, **Content**, and optional **Source references**, one per line.
4. Click **Create memory**.

Search within the selected agent's memories, then select one to read or edit it. Click **Save memory** to save an edit. If another change caused a revision conflict, use **Reload memory** and review the latest version before saving again.

Memories you create or edit through the operator interface are operator-owned; agents cannot modify operator-owned records. Memories are separated by agent owner. They have no automatic expiration or full-memory preload: the agent uses explicit memory tools to retrieve them. A saved fact and its references may become stale; neither proves current runtime state.

[Source: Brains UI](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/brains/BrainsPage.tsx#L72-L119) · [Source: ownership and revisions](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/postgres-brain-store.mjs#L43-L56) · [Source: operator mutations](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/scripts/ui/brain-routes.mjs#L23-L26) · [Source: retrieval contract](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/action-proposal.mjs#L230-L231)


!!! warning "Check the selection before deleting"
    **Delete memory** and **Delete selected memories** act directly in this release; there is no confirmation dialog in the Brains page. **Select page** selects only the visible page. Bulk deletion runs independently for each record, so some deletions may succeed while others fail. Read the per-record result before retrying. This page has no restore button.

[Source: deletion behavior](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/brains/BrainsPage.tsx#L83-L118)

### Optional embeddings

Open **Settings → General → Continuity** to configure embeddings globally. This release supports Google and Ollama embedding adapters; a working chat connection to another provider does not establish embedding support. Choose a supported provider and embedding model, test it, then enable and save the settings. A manually entered model ID requires a successful test before saving an enabled configuration. **Reindex all memories asynchronously** rebuilds the index in the background; the page reports indexed, pending, and failed counts. Partial coverage remains searchable lexically, and saved-memory editing remains separate from indexing.

Enabling a remote embedding provider involves sending memory text to that provider for indexing. Choose the provider with the sensitivity of your saved content in mind.

[Source: embedding controls](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/BrainEmbeddingSettings.tsx#L48-L80) · [Source: supported providers and text requests](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/brain-embedding-provider.mjs#L15-L59)

## Retrieve historical run proof

When you need a past execution result rather than a saved fact, ask the agent to use `run_evidence_search` with a specific query. It searches that agent's retained run proof across sessions; it does not automatically preload history or grant cross-agent access. Retention can remove old records, and a past successful run does not verify today's filesystem or provider state. Use `session_search` when you need original conversation wording instead.

### Dream promotion controls

Automatic Dream-to-Brains publication requires **Promote Dreams to memory** in both **Settings → General → Continuity** and the agent's **Dreams** settings. Both default on. Save changes in each section. Off preserves Dream diaries, reflection, existing memories and explicit saves; re-enabling does not backfill skipped promotions. Current synthesis can update an existing Dream-owned record by ID/revision, or record a no-op/review instead; it does not overwrite operator-owned memories. See [Dream cycles](../concepts/dreams.md#control-automatic-promotion).

### Tune memory expression and preview without saving

In **Settings → Agents → [agent] → Dreams**, use the **Dream memory** panel in the additional-settings column. **Memory emphasis** ranges from **0 Analytical** through **50 Balanced** (default) to **100 Meaning-focused**. It changes final memory expression, not source selection, evidence or citations. SOUL supplies voice, not invented facts. **Memory prompt override** replaces the built-in expression prompt (up to 20,000 characters); even an explicitly empty override is distinct from the default. **Revert to default** restores the default in the draft; use **Save dream settings** to persist changes. The separate **Dream prompt** still controls the diary.

**Preview memories** is an explicit, potentially paid model request using the saved Dream model and the draft expression settings. It does not save memories/settings, publish promotion, or run a full Dream cycle. It reuses recent validated extraction checkpoints that still match eligible REM-window sources: not all history, new extraction, or the existing Brain corpus. No eligible material means no model request. Preview results show source count/references and **Not saved**.

Repeat previews normally reuse the same source sample for up to 15 minutes, allowing expression comparisons without changing evidence; output can still vary. The process-wide cache is bounded and restart/eviction/source changes can invalidate a sample. **Preview new sample** explicitly captures different material. Saving expression changes affects a later authorized synthesis; it is not a bulk rewrite of existing memories. No-save means no Dream-store mutation, **not** no evidence: nonempty production previews retain ordinary filesystem execution traces and model diagnostics under normal retention.

## Scheduled dreaming

Open **Settings → Agents → [agent] → Dreams**. Enable scheduled dreaming, set the cron schedule, choose a model override or inherit the chat model, edit the prompt, and click **Save dream settings**. The schedule follows the operator timezone. **Dream on quiet days** controls whether a day with no new material still generates a diary from retained continuity; when off, such days skip model work.

Expand **Recent activity** below the Dream settings (collapsed by default) for completed, partial, failed, or interrupted cycles and any phase errors. Browse retained dream entries in **Archive → Dreams**. Current Core saves individual **Dream-generated** connections in Brains and excludes DreamMemory and Dream preloads from ordinary context. Those connections are searchable on demand, not injected into every turn. A cycle may legitimately save no new connection. See [Dream cycles](../concepts/dreams.md) for the version-specific behavior.

[Source: dream settings and activity](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/AgentDreams.tsx#L87-L124)
