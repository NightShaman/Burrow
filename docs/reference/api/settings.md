# Settings and integrations


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-11-08**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


These are privileged operator routes. They share the normal interactive authentication gate; `diagnostics:read` Bearer tokens do not authorize them. Stored settings, environment overrides and effective runtime behavior are explained in [configuration](../configuration.md).

## Auth and tokens

`GET /api/settings/ui-auth` returns saved configuration and effective mode/source. PUT supports `mode`, `trustedProxy`, `basic` and `oidc`; secret fields are write-only. Basic accepts a supplied `basic.password` for hashing, while OIDC accepts a nonblank `oidc.clientSecret` for encrypted storage. Read back effective state before assuming a database change overrode the environment. Use the [authentication guide](../../security/authentication.md) to avoid lockout or unsafe exposure.

Create an API token with `name`, optional `scopes` (currently only `diagnostics:read`) and optional future `expiresAt`. The plaintext appears only in the creation result; list returns metadata. DELETE revokes rather than returning the secret. Tokens cannot create more tokens or administer settings.
## Model connections and provider login

In the UI, use **Settings → Connections → Models → Connect**, select the models to enable, and **Save**. Select a saved provider card to edit it. Select the agent in **Chat**, then use its **Provider**, **Model**, provider-specific **Thinking**/**Effort**, and **Temp** controls to persist that agent's selection. Agent details has no model selector. See the [operator walkthrough](../../getting-started/initial-setup.md#configure-a-usable-model).

Connection save accepts `provider`, `apiType`, `baseUrl`, and `models`; include `id` to update an existing connection. Omit `apiKey` to preserve an existing credential, or supply a nonblank replacement. Discovery refreshes provider/catalog facts while preserving explicit operator capability overrides. Discovery, connection authentication, model enablement, and agent selection are separate state transitions.

A per-agent selection uses `connectionId` and `model`, with optional `reasoningEffort` (default `off`), nullable `thinkingMode`, and `temperature` (0–2; omission preserves the prior value or defaults to 0.2). The backend rejects unknown connections, models not enabled in the catalog, absent authentication, and unsupported mode/effort combinations. `/api/agents/{agentId}/minion-model-selection` has the same independent fields. Archive-summary selection is separate and can be cleared. Adapter compatibility can omit saved temperature from the provider request.

For Anthropic Messages and native Anthropic pools, `thinkingMode` is `default`, `disabled`, `adaptive`, `enabled` (Manual), or `between_tools` (No up-front thinking), subject to the selected model's capabilities. Explicit `default` omits the provider thinking field; `null` preserves the legacy effort-based interpretation and is **not** provider default. Omitting mode when saving the same connection/model preserves its prior mode; changing model with omitted mode starts legacy/null. Explicit null clears the selection to legacy. Other provider families reject an explicit Anthropic mode.

Effort Default retains the `off` storage sentinel but omits native effort; it does not disable thinking when an explicit mode is selected. Legacy/null Off resolves to Disabled, so a model that cannot disable thinking needs a deliberate supported mode before running. Native effort names are independent: `xhigh` is not an alias for `max`. The UI retains incompatible saved selections for correction, rather than silently substituting a supported value. Main/minion and turn snapshots retain these controls through continuations.

### Anthropic discovery

Native discovery follows all declared `has_more`/`last_id` pages with `after_id`. Invalid/repeated/missing cursors, cancellation or a later-page failure do not overwrite the saved catalog with a partial result. Legacy single-page proxies can omit paging metadata. Native bounded `anthropicMetadata` and `capabilityProvenance` describe provider facts; missing/null values remain unknown, distinct from explicit unsupported values. Fallback provenance identifies fields filled by the models.dev snapshot. Refresh replaces provider facts while retaining explicit operator overrides and selections; discovered tool support does not enable tools or select a thinking mode. Input/output capacity remains metadata, not a request to spend the full output allowance.

Prompt-cache flags, arbitrary request extras and cache-retention controls are not exposed by the standard model-connection form. See [current cache semantics](../../concepts/models.md#what-caching-currently-means) before treating an adapter option as a supported settings field.

Provider login endpoints are distinct from UI OIDC authentication:

- OpenAI OAuth: start → poll by login ID → submit callback/code if needed → cancel when abandoned
- Claude Code login: start → poll → submit callback if needed → import the acquired credential
- Claude CLI credential status/import: explicit integration with locally available credentials

These flows can establish ongoing provider access. Handle credentials through the supported operator flow, never diagnostic tokens, and do not log raw callback content. Capability/provider-specific details are in [models](../../concepts/models.md).
### Replacing existing OpenAI OAuth tokens

For an existing direct OpenAI OAuth connection, model-connection POST may carry an `oauthTokens` object with only string `id_token`, `access_token` and `refresh_token` fields. Omitted or blank fields preserve existing values. This is credential replacement, not a new sign-in or token-validation endpoint; never include actual tokens in logs, examples or support messages. Do not combine this patch with `auth` or a nonblank `apiKey`, and do not send it to a logical pool.

A replacement access token must contain a parseable JWT payload with a finite positive numeric `exp`. Its expiry and account metadata replace the prior access token's values. Reading JWT metadata is not cryptographic verification or proof the provider will authorize it. Invalid token patches fail without saving the replacement; use the supported provider login flow when establishing a new connection.

### Native OAuth provider pools

Pools are saved through the existing model-connection POST route, not a separate pool API. Use `apiType: "openai-lb"` or `"anthropic-lb"` and a `pool` object with boolean `enabled`, nonempty `memberConnectionIds`, optional `sticky` (default true), and optional `preferEarlierReset` (default false). Member IDs are normalized and deduplicated. Pools use existing saved OAuth connections; they are not a credential upload or account-registration flow.

Members must exist and belong to the matching provider family. OpenAI pools accept OpenAI OAuth connections using `openai-responses` or `openai-chat-completions`; Anthropic pools accept Anthropic/Claude OAuth with `anthropic-messages`. API-key-only members, self-membership, and nested pools are rejected. Discovery now exposes the **intersection** of non-manual model IDs present in every member catalog, selected by default—not the earlier union. Inspect `discovery.status` and `error`, because a manual-only fallback can still return `ok: true`. See [models](../../concepts/models.md) for runtime selection and fallback limits. The generated OpenAPI schema now includes pool settings, but its model-connection description still says union; current source uses the intersection.

## Minion Depth

`GET /api/agents/{agentId}/minion-settings` returns `{ "ok": true, "maxDepth": 1 }` when unset. `PUT` requires `{ "maxDepth": 0 }`, `{ "maxDepth": 1 }` or `{ "maxDepth": 2 }` and returns the saved value with `ok: true`. Settings are durable and isolated per agent, independently of `/minion-model-selection`.

Zero disables spawning; one permits direct children only; two also permits grandchildren. Root depth is zero. Leaves lack the spawn tool and runtime execution independently enforces the ceiling. No extra fan-out or per-spawn depth setting exists. The current setting can tighten a resumed child's saved budget; it does not rewrite ancestry. See [agents and minions](../../concepts/agents-minions.md#minion-depth).

Missing/null/string/boolean/fractional/out-of-range `maxDepth` returns **400 `minion_max_depth_invalid`** without changing settings; omission is not reset-to-default. Malformed JSON returns `invalid_json`. Normal authorization and enabled-agent requirements apply: unknown agent gives `agent_not_found` (404), disabled agent `agent_disabled` (409).

## OpenTelemetry destinations

`GET /api/settings/opentelemetry` returns saved `settings`, `effective` transport, `providers` metadata and safe `runtime` status when available. Current `PUT` atomically replaces the entire list with `{enabled, destinations}`. Each destination has a unique stable `id`, display `name`, supported `provider` and boolean `enabled`; optional transport/authentication fields use provider defaults. An enabled master requires an enabled destination; `{ "enabled": false, "destinations": [] }` is an authoritative empty list, including after restart. A rejected entry leaves the old list intact.

IDs match `[A-Za-z0-9_-]{1,80}` and names are nonempty, up to 160 characters after trimming. Disabled drafts may be incomplete, but supplied values and signal/provider combinations still require validation. Retained scalar fields in GET are compatibility projections; use destination arrays for the full configuration.

Base `endpoint` appends signal paths; `tracesEndpoint`/`metricsEndpoint` are exact URLs. Supported protocols are `http/json` and `http/protobuf`, not gRPC. Enabled entries need an endpoint for each enabled, provider-supported signal. Metric temporality is independently `cumulative` or `delta` per destination. See [destination setup and presets](../../operations/observability.md#configure-destinations) for operator configuration.

`headers` and `credentials` (`username`, `password`, `token`, `caCertificate`) are write-only, encrypted values. Responses expose only configured flags and credential-field names. With the same ID and provider, omitted or empty-string secrets preserve existing values, including when the endpoint changes: trust the new endpoint before saving, because preserved credentials can be sent there. `clearHeaders` and `clearCredentials` explicitly clear the corresponding group; do not combine a true clear with its replacement value. Changing provider or ID never inherits the previous owner's secrets.

The legacy `{enabled, endpoint, headers?, clearHeaders?}` form remains accepted for scalar settings or an equivalent single Custom JSON destination. If it cannot represent the current list, it returns **409 `opentelemetry_legacy_ambiguous`**, not a destructive downgrade. Do not mix list and scalar shapes or send extra top-level keys. Output-only `legacy: true` identifies a virtual old scalar connection whose provider was never recorded; do not infer provider from its label/URL or submit that flag. Reading does not migrate it; the first successful list save adopts it.

Environment endpoint/header overrides select one effective environment destination, without sending environment credentials to every saved destination. The saved list remains unchanged; effective source fields identify overrides. Saving applies live to Core, while existing runs retain their original exporter generation. Remote Node Goblin gateways require matching updated packages. A saved configuration or successful SDK start is not proof of hosted ingestion.

## MCP configuration and grants

Connection save requires `name` (up to 120 characters) and `transport` (`http` or `stdio`). HTTP requires an HTTP(S) `baseUrl`; stdio requires `command` (up to 240 characters), with arguments up to 2,000 characters each. `lifecycle` is `ephemeral` or `keep_alive`, default ephemeral; `enabled` defaults true.

Discover/diagnose use `connectionId`; Diagnose may also receive `toolName` and an object `arguments`, so a diagnostic tool invocation can have provider-side effects. Do not assume every Diagnose operation is a passive health read.

HTTP connection writes can include a `headers` object. Names are case-insensitive, canonicalized to lowercase, at most 128 characters, and duplicate names differing only by case are rejected. At most 64 entries are accepted; each string value is at most 8192 UTF-8 bytes and cannot contain CR, LF or NUL. Values are not trimmed.

Omitting `headers` preserves all existing headers. A supplied map defines the complete retained name set: `null` preserves an already-configured name, a string replaces it, omitted names are removed, and `{}` clears all. A null value for an unknown name fails. Reads expose only `headerNames`, never values. These headers are encrypted with connection secrets; explicit Authorization overrides the legacy Bearer API key, and headers are not sent to stdio providers. See [MCP](../../concepts/mcp.md) for discovery and returned-image behavior.

Agent grants use `{ "tools": [{ "connectionId": "…", "toolName": "…" }] }`; PUT replaces the full set. Read-modify-write deliberately. Secret update rules and the asynchronous delete-acknowledgement caveat are in [MCP](../../concepts/mcp.md).
## Skills, identities and policy

Skills have central PostgreSQL records and per-agent assignments. Current source also supports a managed official catalog alongside Git-backed filesystem packages, tracked package files and synchronization receipts. See the [Skills guide](../../guide/skills-and-memory.md) for managed-catalog and custom-source workflows. An assignment does not expand execution permission; importing a package can place executable support files on disk, so review its source before use. Git preview/import, source management, explicit sync, history and file-download endpoints are listed below. Identity/profile settings likewise differ from authentication principals.

Timezone GET/PUT manages the operator's IANA timezone. Scheduled jobs, Dreams and Git-skill sync schedules all use that zone; per-schedule timezone overrides are retired and reconciliation recalculates upcoming occurrences. Execution-boundary GET/PUT manages concrete configured blockers; see [enforcement limits](../../security/permissions.md).

Browser Origin checking is deployment-only via `BURROW_UI_ORIGIN_CHECK` and `BURROW_UI_ALLOWED_ORIGINS`. The old `/api/settings/browser-origin` route returns 404; stored/imported `browserOrigin` preferences are ignored and new exports omit them. Keep checking enabled unless the deployment has an independent reason to disable it. OpenTelemetry settings read/save a destination list, export enablement and write-only protected transport values; enabling a destination shares curated telemetry with it. See [destination contract](#opentelemetry-destinations).

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
| `GET`, `PUT` | `/api/agents/{agentId}/minion-settings` | Read/save nesting depth 0–2 |
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
| `GET` | `/api/settings/retention` | Read saved retention policy and state only; no cleanup scan |
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
| `GET`, `PUT` | `/api/settings/browser-tab` | Read/save browser tab settings |
| `GET`, `PUT` | `/api/settings/opentelemetry` | Read/save destination list and export settings |
| `POST` | `/api/settings/skills/git/preview` | Preview a Git skill package |
| `POST` | `/api/settings/skills/git/import` | Import a Git skill package |
| `GET`, `PUT`, `DELETE` | `/api/settings/skills/{id}/source` | Read/save/remove Git source metadata |
| `POST` | `/api/settings/skills/{id}/sync` | Synchronize a saved Git source |
| `GET` | `/api/settings/skills/{id}/history` | Read synchronization receipts |
| `GET` | `/api/settings/skills/{id}/files` | List tracked package files |
| `GET` | `/api/settings/skills/{id}/files/{filePath}` | Download a tracked package file |

## Targeted source review

The full page was reconciled on **2026-11-08** against Backend commit `6b682eae6cd0dc6efa79e173b7d819fb219443b3`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/scripts/ui/settings-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/settings-routes.mjs)
- [backend/scripts/ui/general-settings-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/general-settings-routes.mjs)
- [backend/scripts/ui/skill-source-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/skill-source-routes.mjs)
- [backend/src/postgres-scheduled-job-store.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/postgres-scheduled-job-store.mjs)

## 26 October delta review

Updated against Backend `4df4b424e2b2856cb2c25c8464da7f806eb661e0` on **2026-10-26**. This is a focused source comparison since the full review above, not a new application or provider test pass.

## 29 October development delta

Changed contracts above were checked statically against Backend `4057b50a5d5a9b14d36bb3b70f35781c4b29a9b9` on **2026-10-29**. This is not a runtime, provider or collector test, nor a revalidation of unchanged historical sections. See [source coverage](../../project/source-map.md).

## Retention form reads

`GET /api/settings/retention` (and compatibility alias `GET /api/retention`) returns `{ok:true,policy,state}` from PostgreSQL, without scanning trace directories, resolving an execution context or computing a cleanup preview. PUT saves the policy and returns that same shape. Only the explicit `/preview` action computes deletion candidates. `/preview` and `/run` require the exact current policy snapshot; a stale or missing snapshot returns 409 `retention_policy_changed`. Opening Settings does not run cleanup.

## Automatic expiring reset preference

Checked **7 November 2026**: model-connection writes accept `autoUseExpiringResets`, returned on reads and defaulting to `false`. Only literal `true` enables it, and only for a direct OpenAI OAuth connection, not a logical load-balancer pool. The backend polls at startup and every minute for an available credit expiring within ten minutes. It requires stable account identity and a durable claim, then pins the exact credit/expiry. Definite rejection or `nothing_to_reset` may retry that same credit after one minute; ambiguous transport/provider outcomes preserve an account-wide unknown fence. See [operator controls and recovery](../../guide/models.md#automatically-use-expiring-resets). This is not a new HTTP route or a request to edit reset tables.

## Operator UI preferences

Checked **9 November 2026**: `GET /api/settings/ui-preferences` returns `{ "values": {} }` when no preferences are stored. `PATCH` accepts `{ "values": { "hc.theme": "dark", "hc.leftSplit": null }, "seedOnly": false }` and returns the complete merged `{values}`. String values are opaque browser-storage representations; null removes a key and omitted keys remain unchanged. `seedOnly: true` fills missing keys without overwriting or deleting existing entries. Concurrent first writes use the same atomic boundary. Empty patches are valid.

Allowed keys are `hc.theme`, `hc.selectedAgentId`, `hc.leftCollapsed`, `hc.rightCollapsed`, `hc.leftSplit`, `hc.rightSplit`, `hc.leftTopPanel`, `hc.leftBottomPanel`, `hc.rightTopPanel`, `hc.rightBottomPanel`, `hc.leftRailLayout`, `hc.rightRailLayout`, `hc.leftSinglePanel`, `hc.rightSinglePanel`, `hc.rightPanelDefaultsVersion`, `hc.agentRailPreferences`, `hc.groupChatTabs`, `hc.settingsUtilityPanelOpen`, and `hc.accountStatusOrder`.

Unknown keys, unknown top-level fields, malformed bodies, nonboolean `seedOnly`, and values other than string/null return `400 invalid_ui_preferences` without mutation. The home server owns one operator-wide `settings_meta` record named `ui_preferences`, under the existing authentication boundary. This is not per-user or selected-node storage. Credentials, drafts and caches are excluded. See [workspace restoration](../../concepts/interface.md#workspace-preference-synchronization).
