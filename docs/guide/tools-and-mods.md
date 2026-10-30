# Tools, mods, and execution

Current implementation reviewed **26 October 2026**. [Source coverage](../project/source-map.md) records the exact build and verification limits. Existing commit-linked citations identify historical evidence; they are not links to the current development source.

Start here when an agent needs access to files, a service, or another execution machine.

## Understand the three layers

- **Native tools** are built into Burrow: shell execution, file and Git operations, conversation retrieval, agent coordination, task records, and memory. Their availability depends on the runtime context.
- **MCP servers** provide additional tools. Connect a server, discover its tools, then grant the required tools to an agent.
- **Mods** extend Burrow with their own tools, settings, pages, or other capabilities. Install and enable them separately. A skill is an instruction package, not a tool connection.

[Source: native tool catalog](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/action-proposal.mjs#L227-L445) · [Source: MCP and mod distinction](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/McpConnections.tsx#L66-L77)

## Connect an MCP server

1. Open **Settings → Connections → MCP servers**.
2. Enter a **Name** and choose **HTTP** or **Local stdio**.
3. For HTTP, enter the **Server URL** and optional API key. For stdio, enter the **Command**, one argument per line, and any required environment variables. A local stdio command runs on the Burrow host, not in your browser.
4. Choose **Ephemeral** or **Keep alive**. Keep alive preserves a stateful MCP session between calls, useful for servers that maintain tabs or selections.
5. Click **Add MCP server**, then **Discover tools** on the saved server.
6. Open **Settings → Agents**, select an agent, and open **MCP tools**. Select the server and check the tools it may use. Individual grants and Select all/Clear all autosave; check saved feedback and retry failures. Each write uses accepted grants rather than silently committing other failed drafts.

Saved credentials are not shown again. Existing configured secret fields can remain blank when you are not replacing them. Deleting a connection also removes its agent tool grants.

Mod-managed MCP servers are read-only in Connections. Tools marked as mod-authorized do not need ordinary agent grants and are omitted from the grant picker; manage them through the owning mod.

[Source: connection form and discovery](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/McpConnections.tsx#L60-L77) · [Source: agent grants](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/AgentMcpTools.tsx#L46-L81)

### HTTP MCP headers and returned images

HTTP connections now have **HTTP headers → Add header**. Enter the header name and secret value, then save the connection. Existing values are masked: use **Replace** for a new value, or remove the row and save to remove it. Headers apply to HTTP, not stdio. A configured `Authorization` header takes precedence over the API-key-generated Bearer header; do not unintentionally configure conflicting authentication.

Supported image blocks returned by an authorized MCP call are persisted as attachments and can enter a vision-capable model's native continuation. This is typed MCP image content, not arbitrary base64 text extraction; unsupported/invalid/oversized images report a content error. Loading a tool or receiving an image does not change its grants or a model's capabilities. Chat activity now identifies the actual MCP provider/tool and loaded skill rather than only the generic dispatch name.

## Install and enable a mod

1. Open **Settings → Mods → Mod sources**.
2. Add the mod's Git repository URL. Core discovers version-tagged releases containing `burrow.mod.json`. Use **Refresh sources** to check the configured repositories.
3. Open **Installed mods**, select the mod from the catalog, and click **Install**.
4. Check its status, then click **Enable**. Installation alone does not activate it.
5. Open the mod's contributed settings or page, if it provides one, to complete its own configuration.

All mods, including Node Goblin and system mods, start disabled. **Update** and **Reinstall** preserve the current enabled/disabled state. Install, update, enable, and disable normally apply live; follow a **Restart required** notice if Core reports one. If a mod is busy, let its active work finish before trying again.

**Automatic source checks** controls background catalog refreshes. Do not read “checks enabled” as “updates installed.” The mod details show installed, running, and latest source versions separately.

### Private-source credentials in current Core

Checked **24 October 2026**: in **Mod sources**, select an existing source or enter its HTTPS Git URL. The password/access-token field accepts a credential or a supported stored-secret reference. When a loaded provider supplies compatible credentials, **Browse** opens a searchable metadata picker; selecting an entry can fill an empty username. Core resolves the stored reference when accessing the repository—the picker does not reveal its secret value.

A saved source shows **Stored credential configured**. Leave the password/token field empty to keep it; use its explicit **Remove** action to clear it. **Update source** saves a replacement for the selected source. If discovery fails after saving, inspect that source's status rather than assuming nothing was persisted.

This support is for **HTTPS Git mod sources**, not every password field in Burrow. The reference provider must remain loaded and able to resolve the selected value. See [Goblin Secret Store](https://burrow-docs.blissful-psychosis.com/goblin-secret-store/) for its own setup. SSH keys and host trust must be configured for the Core service account; the form does not configure SSH access.

Implementation: `ModsSettings.tsx`, `mod-distribution.mjs` and `secret-references.mjs`; source pins are recorded in [release coverage](../project/release-status.md).

[Source: mod actions and lifecycle](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModsSettings.tsx#L198-L266) · [Source: busy handling](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModsSettings.tsx#L99-L116)

## Where Node Goblin fits

Node Goblin is a separately installed execution-provider mod. Core stores an agent's execution assignment as a provider ID, target ID, and absolute workspace root. It routes supported execution through that provider; installing a mod is not itself a remote-agent assignment.

After installing and enabling Node Goblin, use the settings contributed by your installed Node Goblin version for host connection and assignment. Those screens are owned by that separate package and are not included in this Core checkout, so this guide does not invent host-registration buttons or commands. Check its own release documentation for that part of setup.

If an assigned remote provider is unavailable, Core reports an execution error rather than silently routing that request to local execution. A legacy provider-less gateway assignment can remain unresolved and needs an explicit provider assignment.

[Source: agent assignment format](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/agent-registry.mjs#L10-L35) · [Source: remote routing](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/process-execution-router.mjs#L24-L45) · [Source: Node Goblin provider eligibility](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/execution-provider-approval.mjs#L1-L33)

### Keep access to the home Burrow

When Node Goblin points shell and filesystem tools at a remote host, those tools operate on that host. Install [Burrow Backdoor](https://burrow-docs.blissful-psychosis.com/burrow-backdoor/) in the agent's home Burrow for its diagnostic and supported administrative operations. Backdoor's agent scope and administrative authority still apply.

Core's mod-access settings changed after public 2026.10.19: newer Core permits direct UI use with `authMode: none`, while authenticated mode requires operator login. API tokens do not authorize the operator access-settings route in either path. Updating only the Backdoor package does not update this Core behavior.

For authoring a mod, start with [Burrow Tutor](https://burrow-docs.blissful-psychosis.com/burrow-tutor/) and its [contract guide](https://burrow-docs.blissful-psychosis.com/burrow-tutor/contract/).

## Image generation in ordinary mods

Core builds with ordinary-mod Forge support let a mod check image availability, submit an asynchronous image request, and read its own job later. The operator configures the image selection in Core's Forge settings. The mod supplies its own enablement, authorization, and potential-cost consent flow.

The host API is deliberately small:

```js
await context.forge.images.status();
await context.forge.images.create({ prompt, idempotencyKey });
await context.forge.jobs.read(jobId);
```

These are server-side mod-host calls, not new public HTTP endpoints or agent tools. Installing a mod does not authorize paid image creation. A mod may expose its own routes or tools, but it must apply the appropriate authorization before dispatch.

Creation returns a job receipt; it does not wait for an image. Save stable request intent before submission and retain the returned job ID. Read completion in later requests. `queued` and `running` are nonterminal; `succeeded`, `failed`, and `interrupted` are terminal. A failed read does not establish completion. Reuse the original request key after an ambiguous failure, and never change to a fresh key merely to bypass an unresolved retry or conflict.

Core returns the mod's own image-job status and authenticated preview metadata. It does not expose credentials, storage references, prompts, connection/model IDs, downloads, or another mod's jobs through this facade. The facade has no provider picker, Forge settings mutation, cancellation, attachment delivery, or non-image generation methods.

See [Burrow Tutor's contract guide](https://burrow-docs.blissful-psychosis.com/burrow-tutor/contract/) and [Forge image lesson](https://burrow-docs.blissful-psychosis.com/burrow-tutor/forge-images/) for an authoring example. Check your installed Core's support before adopting it; updating a mod alone does not add a missing Core capability.

## Tutor and the separate Reference Mod example

This walkthrough describes the scaffold bundled in **Burrow Tutor**. The separate **Burrow Reference Mod** is another implementation of the same ordinary-mod contract; its image demonstration has a different UI and route design.

Tutor provides four optional image routes, starts image submission disabled, and requires `confirmPaid: true` with a stable caller-supplied `requestId`. Its existing Control pane remains the greeting example. Add an explicit image-consent UI before exposing the scaffold to operators.

The separate Reference Mod provides a complete manual image demonstration in its Control pane. It has three image routes, accepts prompts up to 4,000 characters with `confirmCost: true`, and retains one request. The server saves a generated key and pending prompt before dispatch, then saves the job ID and removes the pending prompt after a receipt. **Poll saved image job** reads the retained job later; **Retry saved submission** reuses unresolved saved intent. It does not generate images on activation, page load, refresh, or greeting-tool use.

These route names, limits, request fields, and storage choices belong to each example. They are not additional Core APIs. Both examples use only `context.forge.images.status()`, `context.forge.images.create({ prompt, idempotencyKey })`, and `context.forge.jobs.read(jobId)`.

Both examples currently declare the mod ID `burrow-reference-mod`. Treat them as alternative starting points, not two independently installable mods with unchanged manifests. Give an adapted mod its own ID and matching install directory; Core scopes storage, job ownership, and request keys to that identity.

## Permissions and hard blocks


!!! warning "A workspace is not a sandbox"
    Agent workspaces organize files and context. Core explicitly does not create an agent-specific filesystem boundary. Run Burrow and third-party code with appropriate operating-system permissions and only give it access you intend it to have. Mods run JavaScript in a child process; a separate process is not an operating-system sandbox.

To configure a hard block, open **Settings → Agents → Global → Execution boundaries**, click **Add hard block**, and fill in its ID, target type, pattern, match mode, operations, and optional reason. Click **Save boundaries**. Removing or toggling a rule also needs **Save boundaries**.

**Important coverage limits in this release:** the editor offers read, write, delete, execute, and delegate, but the native action-review implementation checks boundaries for file writes/edits/patches, delegation targets, and shell execution. The read-tool branch does not apply those boundary checks. Shell checks examine the command string and an explicitly supplied working directory; they do not inspect every file a command may touch. Do not rely on these settings as comprehensive read/delete protection, a network firewall, or protection against arbitrary third-party code.

For command rules, select **execute**: command-pattern matching is only evaluated for that operation. An allowed native call is reviewed again at execution, but that does not broaden the rule coverage above.

[Source: boundary editor](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ExecutionBoundaries.tsx#L92-L115) · [Source: actual action coverage](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/action-safety.mjs#L43-L243) · [Source: command matching](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/execution-boundaries.mjs#L131-L140) · [Source: execution recheck](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/proposal-execution.mjs#L102-L114) · [Source: workspace scope](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/agent-registry.mjs#L76-L91) · [Source: mod process](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/mod-host.mjs#L110-L112)
