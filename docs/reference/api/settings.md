# Settings and integrations


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-10-25**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


These are privileged operator routes. They share the normal interactive authentication gate; `diagnostics:read` Bearer tokens do not authorize them. Stored settings, environment overrides and effective runtime behavior are explained in [configuration](../configuration.md).

## Auth and tokens

`GET /api/settings/ui-auth` returns saved configuration and effective mode/source. PUT supports `mode`, `trustedProxy`, `basic` and `oidc`; secret fields are write-only. Basic accepts a supplied `basic.password` for hashing, while OIDC accepts a nonblank `oidc.clientSecret` for encrypted storage. Read back effective state before assuming a database change overrode the environment. Use the [authentication guide](../../security/authentication.md) to avoid lockout or unsafe exposure.

Create an API token with `name`, optional `scopes` (currently only `diagnostics:read`) and optional future `expiresAt`. The plaintext appears only in the creation result; list returns metadata. DELETE revokes rather than returning the secret. Tokens cannot create more tokens or administer settings.
## Model connections and provider login

In the UI, use **Settings → Connections → Model providers → Connect**, select the models to enable, and **Save**. Select a saved provider card to edit it. Select the agent in **Chat**, then use its **Provider**, **Model**, **Effort**, and **Temp** controls to persist that agent's selection. Agent details has no model selector. See the [operator walkthrough](../../getting-started/initial-setup.md#configure-a-usable-model).

Connection save accepts `provider`, `apiType`, `baseUrl`, and `models`; include `id` to update an existing connection. Omit `apiKey` to preserve an existing credential, or supply a nonblank replacement. Discovery refreshes provider/catalog facts while preserving explicit operator capability overrides. Discovery, connection authentication, model enablement, and agent selection are separate state transitions.

A per-agent selection uses `connectionId` and `model`, with optional `reasoningEffort` (default `off`) and `temperature` (0–2; omission preserves the prior value or defaults to 0.2). The backend rejects an unknown connection, a model not enabled in its catalog, absent authentication, or an advertised unsupported reasoning effort. Archive-summary selection is independent and can be cleared. There is also a separate per-agent Minion selection at `/api/agents/{agentId}/minion-model-selection`, using the same connection/model, effort and temperature fields. Adapter compatibility rules can omit a saved temperature from the provider request.

Prompt-cache flags, arbitrary request extras and cache-retention controls are not exposed by the standard model-connection form. See [current cache semantics](../../concepts/models.md#what-caching-currently-means) before treating an adapter option as a supported settings field.

Provider login endpoints are distinct from UI OIDC authentication:

- OpenAI OAuth: start → poll by login ID → submit callback/code if needed → cancel when abandoned
- Claude Code login: start → poll → submit callback if needed → import the acquired credential
- Claude CLI credential status/import: explicit integration with locally available credentials

These flows can establish ongoing provider access. Handle credentials through the supported operator flow, never diagnostic tokens, and do not log raw callback content. Capability/provider-specific details are in [models](../../concepts/models.md).
### Native OAuth provider pools

Pools are saved through the existing model-connection POST route, not a separate pool API. Use `apiType: "openai-lb"` or `"anthropic-lb"` and a `pool` object with boolean `enabled`, nonempty `memberConnectionIds`, optional `sticky` (default true), and optional `preferEarlierReset` (default false). Member IDs are normalized and deduplicated. Pools use existing saved OAuth connections; they are not a credential upload or account-registration flow.

Members must exist and belong to the matching provider family. OpenAI pools accept OpenAI OAuth connections using `openai-responses` or `openai-chat-completions`; Anthropic pools accept Anthropic/Claude OAuth with `anthropic-messages`. API-key-only members, self-membership, and nested pools are rejected. Discovery now exposes the **intersection** of non-manual model IDs present in every member catalog, selected by default—not the earlier union. Inspect `discovery.status` and `error`, because a manual-only fallback can still return `ok: true`. See [models](../../concepts/models.md) for runtime selection and fallback limits. The generated OpenAPI schema now includes pool settings, but its model-connection description still says union; current source uses the intersection.

## MCP configuration and grants

Connection save requires `name` (up to 120 characters) and `transport` (`http` or `stdio`). HTTP requires an HTTP(S) `baseUrl`; stdio requires `command` (up to 240 characters), with arguments up to 2,000 characters each. `lifecycle` is `ephemeral` or `keep_alive`, default ephemeral; `enabled` defaults true.

Discover/diagnose use `connectionId`; Diagnose may also receive `toolName` and an object `arguments`, so a diagnostic tool invocation can have provider-side effects. Do not assume every Diagnose operation is a passive health read.

HTTP connection writes can include a `headers` object. Names are case-insensitive, canonicalized to lowercase, at most 128 characters, and duplicate names differing only by case are rejected. At most 64 entries are accepted; each string value is at most 8192 UTF-8 bytes and cannot contain CR, LF or NUL. Values are not trimmed.

Omitting `headers` preserves all existing headers. A supplied map defines the complete retained name set: `null` preserves an already-configured name, a string replaces it, omitted names are removed, and `{}` clears all. A null value for an unknown name fails. Reads expose only `headerNames`, never values. These headers are encrypted with connection secrets; explicit Authorization overrides the legacy Bearer API key, and headers are not sent to stdio providers. See [MCP](../../concepts/mcp.md) for discovery and returned-image behavior.

Agent grants use `{ "tools": [{ "connectionId": "…", "toolName": "…" }] }`; PUT replaces the full set. Read-modify-write deliberately. Secret update rules and the asynchronous delete-acknowledgement caveat are in [MCP](../../concepts/mcp.md).
## Skills, identities and policy

Skills have central PostgreSQL records and per-agent assignments. Current source also supports a managed official catalog alongside Git-backed filesystem packages, tracked package files and synchronization receipts. See the [Skills guide](../../guide/skills-and-memory.md) for managed-catalog and custom-source workflows. An assignment does not expand execution permission; importing a package can place executable support files on disk, so review its source before use. Git preview/import, source management, explicit sync, history and file-download endpoints are listed below. Identity/profile settings likewise differ from authentication principals.

Timezone GET/PUT manages the operator's IANA timezone. Scheduled jobs, Dreams and Git-skill sync schedules all use that zone; per-schedule timezone overrides are retired and reconciliation recalculates upcoming occurrences. Execution-boundary GET/PUT manages concrete configured blockers; see [enforcement limits](../../security/permissions.md).

Browser-origin settings read/save a boolean `checkOrigin`; the environment can override it. Keep checking enabled unless the deployment has an independent reason to disable it. OpenTelemetry settings read/save export enablement, collector endpoint and write-only exporter headers; enabling export shares telemetry with that collector.

Trace retention supports read/save, a non-deleting preview and an explicit run. `/api/retention` and `/api/retention/cleanup` are compatibility aliases; new clients use `/api/settings/retention/*`. Preview and run require the exact current `policy` object; a missing or changed policy returns 409 `retention_policy_changed`. The explicit run uses that supplied current policy without requiring the background enabled flag. This is trace retention, not a per-conversation purge API. Retired Albdruck routes are not a supported cleanup path; see [memory boundaries](memory.md).
## Endpoint inventory

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings/identities` | Read settings |
| `PUT` | `/api/settings/identities` | Update settings |
| `GET` | `/api/settings/curator` | Read curator settings and runtime status |
| `PUT` | `/api/settings/curator` | Save curator selection |
| `GET` | `/api/settings/ui-auth` | Read settings |
| `PUT` | `/api/settings/ui-auth` | Update settings |
| `GET` | `/api/settings/execution-boundaries` | Read settings |
| `PUT` | `/api/settings/execution-boundaries` | Update settings |
| `GET` | `/api/settings/model-connections` | Read settings |
| `POST` | `/api/settings/model-connections` | Update settings |
| `GET` | `/api/settings/mcp-connections` | List MCP connections |
| `POST` | `/api/settings/mcp-connections` | Create or update an MCP connection |
| `POST` | `/api/settings/model-connections/discover` | Discover models |
| `GET` | `/api/settings/model-connections/claude-cli-credential` | Read Claude CLI credential status |
| `POST` | `/api/settings/model-connections/import-claude-cli-credential` | Import Claude CLI credential |
| `DELETE` | `/api/settings/model-connections/{id}` | Delete model connection |
| `POST` | `/api/settings/mcp-connections/discover` | Discover MCP tools |
| `DELETE` | `/api/settings/mcp-connections/{id}` | Delete MCP connection |
| `GET` | `/api/retention` | Deprecated: read retention policy (compatibility) |
| `POST` | `/api/retention/cleanup` | Deprecated: run retention cleanup (compatibility) |
| `GET` | `/api/agents/{agentId}/model-selection` | Read agent model selection |
| `PUT` | `/api/agents/{agentId}/model-selection` | Update agent model selection |
| `GET` | `/api/agents/{agentId}/minion-model-selection` | Read separate Minion model selection |
| `PUT` | `/api/agents/{agentId}/minion-model-selection` | Save separate Minion model selection |
| `GET` | `/api/agents/{agentId}/mcp-tools` | Read agent MCP tools |
| `PUT` | `/api/agents/{agentId}/mcp-tools` | Update agent MCP tools |
| `POST` | `/api/settings/model-connections/openai-oauth/start` | Start OpenAI OAuth login |
| `GET` | `/api/settings/model-connections/openai-oauth/{id}` | Read OpenAI OAuth login status |
| `POST` | `/api/settings/model-connections/openai-oauth/{id}/submit-code` | Submit OpenAI OAuth callback |
| `POST` | `/api/settings/model-connections/openai-oauth/{id}/cancel` | Cancel OpenAI OAuth login |
| `POST` | `/api/settings/model-connections/claude-code-login/start` | Start Claude Code OAuth login |
| `GET` | `/api/settings/model-connections/claude-code-login/{id}` | Read Claude Code login status |
| `POST` | `/api/settings/model-connections/claude-code-login/{id}/submit-code` | Submit Claude Code callback |
| `POST` | `/api/settings/model-connections/claude-code-login/{id}/cancel` | Cancel Claude Code login |
| `POST` | `/api/settings/model-connections/claude-code-login/{id}/import` | Import Claude Code OAuth credential |
| `GET` | `/api/agents/{agentId}/archive-summary-model-selection` | Read optional archive-summary model selection |
| `PUT` | `/api/agents/{agentId}/archive-summary-model-selection` | Set or clear optional archive-summary model selection |
| `GET` | `/api/settings/retention` | Read operator-managed retention policy and cleanup preview |
| `PUT` | `/api/settings/retention` | Save operator-managed retention policy |
| `POST` | `/api/settings/retention/preview` | Preview retention cleanup without deleting traces |
| `POST` | `/api/settings/retention/run` | Run cleanup with the exact current policy |
| `POST` | `/api/settings/mcp-connections/diagnose` | Diagnose MCP connection |
| `GET` | `/api/settings/api-tokens` | List API token metadata |
| `POST` | `/api/settings/api-tokens` | Create a scoped API token |
| `DELETE` | `/api/settings/api-tokens/{tokenId}` | Revoke an API token |
| `GET` | `/api/settings/skills` | List managed skill records |
| `POST` | `/api/settings/skills` | Create a centrally managed text skill |
| `GET` | `/api/settings/skills/{id}` | Read a text skill |
| `PATCH` | `/api/settings/skills/{id}` | Update a text skill |
| `DELETE` | `/api/settings/skills/{id}` | Delete a text skill |
| `GET` | `/api/agents/{agentId}/skills` | Read an agent skill assignment and effective catalog |
| `PUT` | `/api/agents/{agentId}/skills` | Replace an agent skill assignment |
| `GET` | `/api/settings/timezone` | Read operator timezone for agent context and schedules |
| `PUT` | `/api/settings/timezone` | Save operator timezone; schedule reconciliation uses the new zone |
| `GET`, `PUT` | `/api/settings/browser-origin` | Read/save browser Origin checking |
| `GET`, `PUT` | `/api/settings/browser-tab` | Read/save browser tab settings |
| `GET`, `PUT` | `/api/settings/opentelemetry` | Read/save collector and export settings |
| `POST` | `/api/settings/skills/git/preview` | Preview a Git skill package |
| `POST` | `/api/settings/skills/git/import` | Import a Git skill package |
| `GET`, `PUT`, `DELETE` | `/api/settings/skills/{id}/source` | Read/save/remove Git source metadata |
| `POST` | `/api/settings/skills/{id}/sync` | Synchronize a saved Git source |
| `GET` | `/api/settings/skills/{id}/history` | Read synchronization receipts |
| `GET` | `/api/settings/skills/{id}/files` | List tracked package files |
| `GET` | `/api/settings/skills/{id}/files/{filePath}` | Download a tracked package file |

## Targeted source review

The full page was reconciled on **2026-10-25** against Backend commit `3bf50374d3601c821e787912d52b9044eaf649ec`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/scripts/ui/settings-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/settings-routes.mjs)
- [backend/scripts/ui/general-settings-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/general-settings-routes.mjs)
- [backend/scripts/ui/skill-source-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/skill-source-routes.mjs)
- [backend/src/postgres-scheduled-job-store.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/postgres-scheduled-job-store.mjs)

## 26 October delta review

Updated against Backend `4df4b424e2b2856cb2c25c8464da7f806eb661e0` on **2026-10-26**. This is a focused source comparison since the full review above, not a new application or provider test pass.
