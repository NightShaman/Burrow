# Tools, mods, and execution

This guide follows the public **2026.10.19** release. Start here when an agent needs access to files, a service, or another execution machine.

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
6. Open **Settings → Agents**, select an agent, and open **MCP tools**. Select the server, check the tools it may use, then click **Save MCP tools**.

Saved credentials are not shown again. Existing configured secret fields can remain blank when you are not replacing them. Deleting a connection also removes its agent tool grants.

Mod-managed MCP servers are read-only in Connections. Tools marked as mod-authorized do not need ordinary agent grants and are omitted from the grant picker; manage them through the owning mod.

[Source: connection form and discovery](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/McpConnections.tsx#L60-L77) · [Source: agent grants](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/AgentMcpTools.tsx#L46-L81)

## Install and enable a mod

1. Open **Settings → Mods → Mod sources**.
2. Add the mod's Git repository URL. Core discovers version-tagged releases containing `burrow.mod.json`. Use **Refresh sources** to check the configured repositories.
3. Open **Installed mods**, select the mod from the catalog, and click **Install**.
4. Check its status, then click **Enable**. Installation alone does not activate it.
5. Open the mod's contributed settings or page, if it provides one, to complete its own configuration.

All mods, including Node Goblin and system mods, start disabled. **Update** and **Reinstall** preserve the current enabled/disabled state. Install, update, enable, and disable normally apply live; follow a **Restart required** notice if Core reports one. If a mod is busy, let its active work finish before trying again.

**Automatic source checks** controls background catalog refreshes. Do not read “checks enabled” as “updates installed.” The mod details show installed, running, and latest source versions separately.

For private repositories, the source form accepts HTTPS credentials and stores them encrypted in Core. SSH keys and host trust must be configured for the Core service account; the form does not configure SSH access.

[Source: mod actions and lifecycle](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModsSettings.tsx#L198-L266) · [Source: busy handling](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ModsSettings.tsx#L99-L116)

## Where Node Goblin fits

Node Goblin is a separately installed execution-provider mod. Core stores an agent's execution assignment as a provider ID, target ID, and absolute workspace root. It routes supported execution through that provider; installing a mod is not itself a remote-agent assignment.

After installing and enabling Node Goblin, use the settings contributed by your installed Node Goblin version for host connection and assignment. Those screens are owned by that separate package and are not included in this Core checkout, so this guide does not invent host-registration buttons or commands. Check its own release documentation for that part of setup.

If an assigned remote provider is unavailable, Core reports an execution error rather than silently routing that request to local execution. A legacy provider-less gateway assignment can remain unresolved and needs an explicit provider assignment.

[Source: agent assignment format](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/agent-registry.mjs#L10-L35) · [Source: remote routing](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/process-execution-router.mjs#L24-L45) · [Source: Node Goblin provider eligibility](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/execution-provider-approval.mjs#L1-L33)

## Permissions and hard blocks

!!! warning "A workspace is not a sandbox"
    Agent workspaces organize files and context. Core explicitly does not create an agent-specific filesystem boundary. Run Burrow and third-party code with appropriate operating-system permissions and only give it access you intend it to have. Mods run JavaScript in a child process; a separate process is not an operating-system sandbox.

To configure a hard block, open **Settings → General → Execution boundaries**, click **Add hard block**, and fill in its ID, target type, pattern, match mode, operations, and optional reason. Click **Save boundaries**. Removing or toggling a rule also needs **Save boundaries**.

**Important coverage limits in this release:** the editor offers read, write, delete, execute, and delegate, but the native action-review implementation checks boundaries for file writes/edits/patches, delegation targets, and shell execution. The read-tool branch does not apply those boundary checks. Shell checks examine the command string and an explicitly supplied working directory; they do not inspect every file a command may touch. Do not rely on these settings as comprehensive read/delete protection, a network firewall, or protection against arbitrary third-party code.

For command rules, select **execute**: command-pattern matching is only evaluated for that operation. An allowed native call is reviewed again at execution, but that does not broaden the rule coverage above.

[Source: boundary editor](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ExecutionBoundaries.tsx#L92-L115) · [Source: actual action coverage](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/action-safety.mjs#L43-L243) · [Source: command matching](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/execution-boundaries.mjs#L131-L140) · [Source: execution recheck](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/proposal-execution.mjs#L102-L114) · [Source: workspace scope](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/agent-registry.mjs#L76-L91) · [Source: mod process](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/mod-host.mjs#L110-L112)
