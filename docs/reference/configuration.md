# Configuration

BURROW stores operator-managed configuration in PostgreSQL. The service environment supplies deployment paths, database connectivity, encryption keys and optional overrides. The retained `loadBurrowConfig()` function is inert: it does not read or write `burrow.json`.

[Configuration authority](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L51-L60) · [Runtime composition](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/runtime-config-loader.mjs#L4-L34)

## Choose the right configuration surface

| Setting | Authoritative surface | Operator entry point |
|---|---|---|
| Agents, identities, six profile documents | PostgreSQL registry, identity and profile stores | Settings → Agents; General operator profile |
| Model connections, credentials, enabled models, agent selection | PostgreSQL model settings | Settings → Connections → Model providers; Chat toolbar model selector |
| MCP connections, discovered catalog and per-agent tool grants | PostgreSQL MCP settings | Settings → Connections → MCP servers; agent MCP tools |
| UI authentication | PostgreSQL settings and secret store, with explicit environment overrides | Settings → Connections → Authentication |
| Execution hard boundaries | PostgreSQL metadata | Settings → General |
| Operator timezone | PostgreSQL metadata | Settings → General |
| Skills and per-agent assignments | PostgreSQL skill store | Settings → Skills; per-agent assignments under Agents |
| Dream schedule and model selection | PostgreSQL agent Dream settings | Agent Dreams settings |
| Retention | Saved trace policy; separate CLI session-retention policy | Settings → General → Trace retention; deliberate CLI maintenance |
| Brains | Agent-owned saved memories; optional embedding settings | Brains; Settings → General → Brain memory |
| Database, listener, process paths, encryption key | Service environment and installer/container configuration | Service environment file or deployment configuration |
| Theme, rail layout, drafts, cached conversations | Browser-local storage/state | UI appearance and navigation |

These are separate ownership domains. Copying a workspace directory does not copy all application settings; exporting selected categories is not a complete backup. See [storage](../architecture/persistence.md), [backup and recovery](../operations/backup-recovery.md), and [browser state](../concepts/interface.md).

[Settings routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/settings-routes.mjs#L1-L70) · [General settings routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/general-settings-routes.mjs#L1-L46)

## Resolution and overrides

Runtime composition requires injected PostgreSQL-backed stores; there is no silent fallback to a local settings file. A caller can explicitly tolerate model-resolution errors for inspection, but normal execution still needs a usable model selection.

For UI authentication, precedence is explicit runtime arguments → service environment → persisted settings → defaults. A saved authentication form can therefore differ from the effective mode. `GET /api/settings/ui-auth` returns both the saved `auth` object and `effective` mode, enabled state and source. Responses report whether secrets are configured rather than returning them. Saving an omitted Basic password preserves its existing hash; a nonblank supplied OIDC client secret replaces the encrypted stored secret.

Listener host/port are selected at process start. Changing the service environment requires a restart. The direct HTTP entry point defaults to `0.0.0.0:42817`; the native installer explicitly writes `127.0.0.1`, while Docker uses `0.0.0.0`. The generic configuration resolver's loopback default does not override the server entry point. Set the listener deliberately before enabling remote access.

[Auth resolution](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L160-L197) · [Saved/effective auth](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L699-L778) · [Listener](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L114-L120)

## Paths and agent ownership

The native installer normally uses `$HOME/.burrow`. The generic runtime fallback is `/mnt/local/burrow`; it is not the native installation recommendation. Explicit path arguments precede environment values. Agent workspaces normally resolve under the shared workspace root, with agent data and workspace pointing to the same selected tree.

| Resolved path | Default relative to configured roots |
|---|---|
| Workspace | `<runtimeRoot>/workspace` |
| Agent workspace/data | `<workspaceRoot>/<agentId>` |
| Skills fallback | `<agentWorkspaceRoot>/skills` |
| Cache | `<runtimeRoot>/cache` |
| Archive | `<runtimeRoot>/archive` |

An explicit workspace-root argument suppresses the ambient agent-workspace override. A workspace or data root is ownership/context information, not a filesystem sandbox. Configure [execution boundaries](../security/permissions.md) separately and use operating-system isolation where required.

[Path resolution](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L200-L228) · [Installation](../getting-started/installation.md)

## Models and generation defaults

Select an enabled connection and an enabled model within it. Agent defaults can supply the pair; explicit per-turn fields override the corresponding selection. A missing pair returns no model; an unknown connection or disabled model is an error. Provider credentials are resolved from the authoritative connection store. All model connections use the direct API runtime.

| Parameter | Runtime behavior |
|---|---|
| Reasoning effort | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; selected provider/model may support a subset |
| Temperature | Default `0.2`, finite range `0..2`; omitted when unsupported by the selected model |
| Context capacity | Explicit model metadata wins; fallback is 292,000 for the OpenAI family and 1,000,000 for Anthropic |
| Output budget | Explicit positive request/model generation limit wins; general fallback is 32,768 tokens |
| Image input | Per-model accepted input takes precedence over connection-level compatibility metadata |

Capacity fallbacks are BURROW defaults, not a guarantee of a provider's current limits. Catalog output capacity is metadata and is distinct from the requested generation limit. See [models](../concepts/models.md) before changing provider details.

[Model resolution](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L15-L41) · [Selection and capabilities](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L62-L145)

## Context compression

Compression policy is runtime configuration, not a client-owned chat-body setting. Defaults are a 0.75 threshold, 48 fresh-tail messages, 24,000 fresh-tail tokens, 20,000 leaf-chunk tokens, a 6,000-token summary target, at most four sweep iterations and a 120,000 ms deadline. A summary-model override is optional. See the exact [environment variables](environment.md#context-and-memory) and [conversation history](../concepts/conversation-history.md).

[Compression defaults](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/context-compression.mjs#L57-L79)

## Timezone and independent retention policies

The operator timezone is an IANA name used by agent context and inherited schedules. Jobs with a null timezone inherit the current operator zone; reconciliation recomputes their next run when that zone changes. Jobs with an explicit timezone retain it. Saving the operator zone does not force browser-local display into that zone. Dreams likewise support explicit or inherited timezone. Trace cleanup, original-conversation retention, working-memory expiration and rolling-continuity history are separate mechanisms. Do not use old session-age environment defaults as a substitute for the current operator policy.

[Inherited schedule reconciliation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-scheduled-job-store.mjs#L169-L178) · [Timezone API](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/settings-routes.mjs#L7-L10) · [Trace retention API](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/general-settings-routes.mjs#L36-L46) · [Dreams](../concepts/dreams.md) · [Memory retention](../concepts/memory.md)

## Portable agent context

The `burrow.agent-context/v1` format carries descriptive context: personality, operator preferences, orientation, declared tool/skill identifiers and an optional HTTP(S) UI target. Each of the three context text fields is limited to 24,000 characters; tool/skill identifiers use `[a-zA-Z0-9._-]{1,96}`. UI-target URLs are limited to 2,000 characters, with a 240-character label.

Unknown fields are discarded. This format does not define executable tools, grant permissions, select a model or establish memory-routing authority. Its text limits differ from the six profile-document limits. An advertised UI target is context, not an automatic browser launch.

[Portable context contract](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/agent-context-config.mjs#L1-L98)
