# Permissions and execution boundaries

BURROW separates HTTP access, agent tool grants, concrete action checks, and operating-system access. These controls answer different questions. A successful UI login does not make a tool result safe, and an agent workspace is not a filesystem sandbox.

This page describes static implementation at commit `c15064dd177788afcdda357a5e545510f754a754` (version **2026.10.10.4**). It does not certify a deployed host's isolation.

## Where authority lives

| Control | What it governs | What it does not establish |
|---|---|---|
| [HTTP authentication](authentication.md) | Admission to UI/API routes; restricted bearer diagnostics access | Tenant isolation or native process containment |
| MCP agent grants | Whether an agent can invoke an exact connection/tool pair | Safety of every argument or the provider's own permissions |
| Execution hard blocks | Selected concrete path/command operations | An OS sandbox or a complete interpretation of shell effects |
| Agent context and profiles | Prompt content, instructions, selected skills and working context | New executable grants or kernel-enforced file permissions |
| Host/container configuration | Actual process credentials, mounts, network and OS controls | A property supplied automatically by workspace naming |

The request router selects prompt/context support and emits action observability. It is not a general approval engine. Concrete tool inputs and execution capabilities are checked later. [Source: router contract](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/request-router.mjs#L20-L53)

## Agent roots are selected context

Agent roots organize profiles, skills, artifacts, and runtime context. The default `filesystemBoundaries` list is empty. Structural filesystem targets resolve an existing directory, including its real path, but return no containment boundary. The execution context explicitly treats agent roots as selected context and keeps ordinary filesystem inspection open to agents. Absolute file paths and shell working directories can therefore refer outside the agent home when the service account can access them.

Use a dedicated least-privilege service account, deliberate container mounts, and independently configured host/network controls for isolation. Do not place unrelated sensitive files within that account's reach and rely on an agent's selected workspace to hide them. [Source: runtime roots](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/config.mjs#L212-L226) · [Source: structural target](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/execution-context.mjs#L25-L41) · [Source: context is not access control](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/execution-context.mjs#L84-L117)

## Concrete action review

The runtime reviews normalized tool actions before dispatch. Unsupported tools are blocked. Parser/validation errors remain blockers. The executor requires a supplied allowed review and then re-runs review at the concrete execution boundary, so a stale or fabricated allowed review cannot bypass those checks. [Source: review dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/action-safety.mjs#L43-L268) · [Source: executor recheck](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/proposal-executor.mjs#L94-L114)

### Configured hard blocks

Hard blocks are stored under PostgreSQL metadata key `execution_boundaries`, as version 1 data with a `hardBlocks` array. Rules have an ID, an enabled flag, type `path` or `command`, pattern, matching method, operations, and optional reason.

- Matching methods: `exact`, `prefix`, `glob`, `regex`, `contains`
- Accepted operation names: `read`, `write`, `delete`, `execute`, `delegate`
- Path targets are resolved lexically against the supplied base root; they are not all resolved through `realpath`
- A matching enabled rule produces a `hard_policy_block:user_configured_hard_block` blocker
- Invalid saves return validation errors; invalid stored data read by the loader falls back to empty boundaries

Because invalid stored data falls back to no rules, verify the effective saved configuration rather than assuming a malformed record fails closed. See [Configuration](../reference/configuration.md). [Source: schema, validation and persistence](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/execution-boundaries.mjs#L3-L84) · [Source: matching](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/execution-boundaries.mjs#L87-L160)

### Effective enforcement scope

The accepted operation vocabulary is broader than the native review call sites. In this version:

| Native action | Boundary evaluation performed by action review |
|---|---|
| `files_write`, `files_edit` | `write` against the supplied file path |
| `files_patch` | `write` against paths extracted from recognized unified-diff headers |
| `shell_exec` | `execute` against command text and the explicitly supplied `cwd`, if any |
| `spawn_subagent` | `delegate` against an explicit filesystem target root |
| Filesystem reads/list/find/inspect/search and Git status/diff | Validation review; this branch does not evaluate execution hard blocks |

There is no independent native `delete` hard-block evaluation in this review function. A shell command's eventual file effects are not parsed into complete read/write/delete targets; checking its command string or `cwd` is not equivalent to controlling every file it accesses. Patch-path extraction recognizes particular diff headers, not every possible patch representation. These limitations are important when designing deny rules. [Source: read review](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/action-safety.mjs#L32-L72) · [Source: mutation and delegation checks](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/action-safety.mjs#L121-L244)

!!! warning "No default command safety classifier"
    Ordinary mutations are permitted absent applicable configured blockers. A command's display labels, a natural-language instruction, or a selected project do not create a hard deny rule. Shell commands can reach resources permitted by the host account.

The execution-policy helper filters for explicit user-configured hard blockers. Its mutation capability is allowed when those blockers are absent, and its commit capability additionally requires structural action `factory` or `commit`. This is the helper's workflow policy, not a guarantee that arbitrary `git` commands inside unrestricted shell are prohibited. Legacy mutation/commit gates use observed tool receipts and verification evidence; they are workflow safeguards, not kernel isolation. [Source: policy helper](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/execution-policy.mjs#L9-L37) · [Source: mutation and commit gates](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/mutation-gates.mjs#L430-L573)

## Minion boundary propagation

Local minion dispatch forwards the parent's `executionBoundaries` in its child payload. The child reconstructs that trusted context; its review and concrete execution receive the boundaries. In-process remote children retain the parent execution context and remote controller. Cancellation is also forwarded into child tool execution. This propagates the configured checks described above, not OS containment or a broader deny-rule interpretation. [Source: dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/subagent-tool-executor.mjs#L331-L353) · [Source: local child context](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/subagent-worker-child.mjs) · [Source: child review and execution](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/subagent-worker-runner.mjs#L145-L169)

## MCP and mod tool grants

Saving a connection or discovering its catalog does not grant an agent permission to invoke all its tools. A normal invocation needs an enabled connection, an exact catalog tool name, and an agent grant for that connection/tool pair. Provider selection uses an exact connection ID or a unique case-insensitive display name. An ambiguous name cannot select a provider.

Catalog visibility and invocation permission are distinct: capability discovery can show `granted: false`. Follow [MCP connections and grants](../concepts/mcp.md) to configure the intended set; scope the provider's own credentials to the minimum required access. `mcporter` transports the request and is not the authority for BURROW agent grants. [Source: provider and grant lookup](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/mcp-menu.mjs#L14-L80)

Mod-provided tools use the same catalog model with a live `mod` transport. A tool marked `mod-authorized` delegates record/agent authorization to its trusted handler; this exception does not apply to arbitrary HTTP or stdio MCP providers. For mod calls, execution re-reads current connection/grant state and checks the live host/tool identity, including when an action was queued earlier in the turn. Ordinary external MCP calls use the resolved execution-context connection/grant data. Do not promise the same database reread for every transport. [Source: mod-only exception](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/mcp-menu.mjs#L27-L30) · [Source: execution-time checks](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/proposal-executor.mjs#L325-L355)

Mod handlers receive untrusted arguments separately from trusted caller context and must implement their own argument and record-access checks. Installation is a code-trust decision; see [Extensions](../development/extensions.md) and [Trust boundaries](trust-boundaries.md#installed-mods-are-trusted-code). [Source: handler invocation](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/mod-host-child.mjs#L197-L205)

## Protected values

Protected values reduce accidental credential exposure in model-visible tool results. They do not authorize a tool call or contain arbitrary shell code.

1. A producer returns an explicit `$burrowSensitive` envelope with type `credential`, `secret`, `token`, `password`, or `private-key`
2. BURROW stores the raw leaf in the turn's in-memory registry and returns an opaque `protected://` handle
3. A compatible later process request supplies that handle through `protectedBindings`
4. The backend resolves the value for the process and supplies known values to output-redaction handling

A malformed explicit declaration withholds the entire response and removes handles created from it. Supported credential-provider adapters also protect known response shapes; arbitrary unmarked output is not automatically a secret envelope. [Source: protected leaves](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/protected-values.mjs#L3-L29) · [Source: protection and withholding](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/protected-values.mjs#L211-L268)

Managed `$burrowManaged` references additionally carry an issuer, version, and lifetime. Consumption checks exact agent/session/conversation identity, expiry, current authorization, and provider resolution. The historical synchronous resolver rejects managed references. A protected reference is not a persistent credential and should not be reconstructed or inserted into command text. [Source: binding resolution](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/protected-values.mjs#L271-L311) · [Source: process dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/proposal-executor.mjs#L129-L167)

Once a process receives a credential, that process can use it. Protected handles and exact-value output replacement are not data-loss prevention, network restrictions, or a shell-command allowlist. Keep the surrounding [host and provider trust boundaries](trust-boundaries.md) appropriate for the work.

## Related references

- [Tools and execution](../concepts/tools.md): tool behavior, filesystem/process routing, and evidence
- [Authentication](authentication.md): UI/API admission and diagnostics token scope
- [Trust boundaries](trust-boundaries.md): secret storage, code trust, and deployment controls
- [Known limitations](../project/known-limitations.md): cross-cutting implementation caveats
