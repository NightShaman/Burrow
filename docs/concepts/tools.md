# Tools and execution

Tools are structured capabilities supplied to a model request. The model chooses a tool and arguments; the runtime normalizes the call, reviews it, dispatches it, and returns an observed result. A tool's presence does not establish that a particular invocation will succeed.

## Native tool families

The effective schema depends on runtime context and enabled integrations. The native catalog includes:

| Family | Examples | Purpose |
|---|---|---|
| Filesystem | `files_read`, `files_list`, `files_find`, `files_inspect`, `files_search` | Inspect paths and bounded content |
| File mutation | `files_write`, `files_edit`, `files_patch` | Write complete content, exact replacement, or patch |
| Process and Git | `shell_exec`, `git_status`, `git_diff` | Execute commands or collect repository evidence |
| Conversation and continuity | `session_search`, `session_read_handoff`, `memory_working_search`, `memory_rolling_search` | Retrieve agent-scoped support evidence |
| Continuity updates | `memory_working_write`, `session_write_handoff` | Record explicitly structured operational context |
| Coordination | `spawn_subagent`, `agent_send_message` | Child tasks or registered peer agents |
| Work records | `tasks_*`, `scheduled_jobs_*` | Task metadata and scheduled prompts |
| Discovery | `list_skills`, `load_skill`, `mcp_providers`, `mcp_capabilities`, `mcp_call` | Load instructions or discover/invoke integrations |
| Generation | `forge_*` | Asynchronous media jobs and artifact attachment |

Schemas, required fields, and feature filters are defined centrally. The supplied schema is authoritative for a particular turn; do not assume every row is available to every agent or minion. [Source: native tool catalog](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/action-proposal.mjs#L219-L445)

See [MCP](mcp.md), [Agents and minions](agents-minions.md), and [Workers and tasks](workers-tasks.md) for those specific workflows.

## Files and working directories

Relative file paths resolve under the current execution root, normally the agent home. A structural filesystem target replaces that root for the turn. An absolute `cwd` applies to one `shell_exec` call; it does not persist as a UI/session project selection. [Source: path resolution](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/proposal-executor.mjs#L27-L52)

Example native calls:

```json
{
  "filePath": "/srv/projects/example/src/parser.mjs",
  "offsetBytes": 0,
  "maxBytes": 32000
}
```

```json
{
  "command": "npm test",
  "cwd": "/srv/projects/example",
  "reason": "Run the project's test command after the change"
}
```

### Read evidence and truncation

`files_read` supports byte ranges and reports total size, returned bytes, offset, truncation, and the next offset. Its harness default is 512,000 bytes. Later receipt/prompt projections can be smaller than the raw read, so distinguish the source range read from the content actually delivered to the model. Continue at the reported next range when necessary; a truncated read is not a full-file inspection. [Source: read harness](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/harness/read-file.mjs#L23-L102) [Source: coverage and delivery](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/runtime-result-shapes.mjs#L28-L87)

Listing, finding, and searching are bounded operations:

- Listing defaults to depth 4 and 500 entries
- Find defaults to depth 8, with a bounded scan
- Search uses literal, case-sensitive text matching; default maximum 200 matches
- Search skips oversized files and uses a cumulative scan budget
- Directory traversal does not descend symlink directories

Inspect truncation and warning fields before interpreting an empty or partial result as exhaustive. [Source: developer tools](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/harness/developer-tools.mjs#L69-L179)

### Mutations

`files_write` writes complete content and can create parent directories. `files_edit` requires the exact `oldText` to occur once. `files_patch` accepts unified diff or the supported structured patch dialect and records Git evidence around the operation.

!!! warning "Multi-file patches are not transactions"
    A structured patch may change earlier files before a later operation fails. Inspect the actual results and repository diff after a failure; do not assume rollback. Workspace validation is advisory, not a sandbox guarantee.

For another project, prefer explicit absolute paths or a shell command with explicit `cwd`, as directed by the tool schema. `files_patch` is not in the remote-native filesystem routing set. [Source: mutation schemas](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/action-proposal.mjs#L369-L395) [Source: patch implementation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/harness/apply-patch.mjs#L135-L281)

## Process execution

The harness supports either a shell command string or an executable plus string argument array. Those forms are mutually exclusive. Native `shell_exec` exposes the command-string form; built-in Git helpers use argument arrays.

Defaults include a 30-second timeout and bounded stdout/stderr capture. The normal harness environment starts with `PATH` and `HOME`, then explicit overrides; it is not a promise to inherit the complete service environment. On Unix, timeout/cancellation terminates the process group and escalates from TERM to KILL. [Source: process harness](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/harness/exec.mjs#L39-L174)

Remote process/filesystem operations carry provider ID, target ID, parent run ID, tool call ID, and an operation ID. Those fields establish where a result came from; a familiar path alone does not identify the machine. [Source: execution provenance](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/proposal-executor.mjs#L33-L41)

## Review and permissions

Every allowed action is re-reviewed at the concrete executor boundary. A stale or forged earlier “allowed” review cannot bypass current malformed-argument checks or configured hard blocks. Denied or invalid native calls produce failed tool results so the model can correct its arguments while preserving provider call/result pairing. [Source: executor recheck](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/proposal-executor.mjs#L78-L92) [Source: failed-call pairing](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/runtime-orchestrator.mjs#L112-L160)

Agent roots do not provide operating-system isolation. Read [Permissions](../security/permissions.md) and [Trust boundaries](../security/trust-boundaries.md) for the actual enforcement model and caveats.

### Protected values

An integration may return a `protected://` reference instead of a sensitive value. A compatible later tool can use that reference through `protectedBindings`, mapping an environment variable name to the reference. The backend resolves the value and injects it into that process; the model should not reconstruct the value or place it in command text.

```json
{
  "command": "example-client status",
  "protectedBindings": {
    "EXAMPLE_TOKEN": "protected://reference-from-an-earlier-result"
  }
}
```

This is illustrative: the reference must come from a real earlier result and remain valid for that caller and turn. It is not a persistent credential string. [Source: protected binding resolution](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/proposal-executor.mjs#L107-L162)

## Results, verification, and diagnostics

Raw outputs belong to the producing tool and its trace artifacts. Loop state, persisted entries, and child handoffs retain bounded receipts. Successful execution proves that operation's reported outcome, not that the entire user objective is satisfied.

Normal chat reports completion evidence; legacy mutation workflows apply additional verification gates. A test-looking command name alone is not a universal proof of verification, and mutation recognition differs between current and legacy helpers. See [Execution flow](../architecture/execution-flow.md) and [Known limitations](../project/known-limitations.md).

Treat traces as potentially sensitive. Bounded output and selective redaction are not a guarantee that all artifacts are safe to publish. [Source: receipt ownership rule](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/runtime-result-shapes.mjs#L3-L17)
