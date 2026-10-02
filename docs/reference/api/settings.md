# Settings and integrations

These are privileged operator routes. They share the normal interactive authentication gate; `diagnostics:read` Bearer tokens do not authorize them. Stored settings, environment overrides and effective runtime behavior are explained in [configuration](../configuration.md).

## Auth and tokens

`GET /api/settings/ui-auth` returns saved configuration and effective mode/source. PUT supports `mode`, `trustedProxy`, `basic` and `oidc`; secret fields are write-only. Basic accepts a supplied `basic.password` for hashing, while OIDC accepts a nonblank `oidc.clientSecret` for encrypted storage. Read back effective state before assuming a database change overrode the environment. Use the [authentication guide](../../security/authentication.md) to avoid lockout or unsafe exposure.

Create an API token with `name`, optional `scopes` (currently only `diagnostics:read`) and optional future `expiresAt`. The plaintext appears only in the creation result; list returns metadata. DELETE revokes rather than returning the secret. Tokens cannot create more tokens or administer settings.

[Auth settings](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L699-L778) · [Token store](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-api-token-store.mjs#L3-L35)

## Model connections and provider login

Save/discover connections before selecting an enabled model for an agent. A per-agent selection uses `connectionId` and `model`, with optional reasoning/temperature preferences. Discovery refreshes provider/catalog facts while preserving explicit operator capability overrides. Archive-summary selection is independent and can be cleared.

Provider login endpoints are distinct from UI OIDC authentication:

- OpenAI OAuth: start → poll by login ID → submit callback/code if needed → cancel when abandoned
- Claude Code login: start → poll → submit callback if needed → import the acquired credential
- Claude CLI credential status/import: explicit integration with locally available credentials

These flows can establish ongoing provider access. Handle credentials through the supported operator flow, never diagnostic tokens, and do not log raw callback content. Capability/provider-specific details are in [models](../../concepts/models.md).

[Model/login routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/settings-routes.mjs#L22-L47) · [Agent selection](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L600-L624)

## MCP configuration and grants

Connection save requires `name` (up to 120 characters) and `transport` (`http` or `stdio`). HTTP requires an HTTP(S) `baseUrl`; stdio requires `command` (up to 240 characters), with arguments up to 2,000 characters each. `lifecycle` is `ephemeral` or `keep_alive`, default ephemeral; `enabled` defaults true.

Discover/diagnose use `connectionId`; Diagnose may also receive `toolName` and an object `arguments`, so a diagnostic tool invocation can have provider-side effects. Do not assume every Diagnose operation is a passive health read.

Agent grants use `{ "tools": [{ "connectionId": "…", "toolName": "…" }] }`; PUT replaces the full set. Read-modify-write deliberately. Secret update rules and the asynchronous delete-acknowledgement caveat are in [MCP](../../concepts/mcp.md).

[Input validation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/mcp-settings-store.mjs#L30-L54) · [Diagnose and grants](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L402-L410)

## Skills, identities and policy

Managed skills are central text records with per-agent assignments. They describe reusable instructions; assignments do not install executables or expand execution permission. Identity/profile settings likewise differ from authentication principals.

Timezone GET/PUT manages the operator's IANA timezone. Explicit-timezone schedules retain that timezone; inherited schedules track the current operator zone. Execution-boundary GET/PUT manages concrete configured blockers; see [enforcement limits](../../security/permissions.md).

Trace retention supports read/save, a non-deleting preview and an explicit run. `/api/retention` and `/api/retention/cleanup` are compatibility aliases; new clients use `/api/settings/retention/*`. This policy does not replace [Albdruck retention](memory.md).

[General settings](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/general-settings-routes.mjs#L1-L46) · [Skills](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/settings-routes.mjs#L11-L21)


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
| `POST` | `/api/settings/retention/run` | Run cleanup using the enabled retention policy |
| `POST` | `/api/settings/mcp-connections/diagnose` | Diagnose MCP connection |
| `GET` | `/api/settings/api-tokens` | List API token metadata |
| `POST` | `/api/settings/api-tokens` | Create a scoped API token |
| `DELETE` | `/api/settings/api-tokens/{tokenId}` | Revoke an API token |
| `GET` | `/api/settings/skills` | List centrally managed text skills |
| `POST` | `/api/settings/skills` | Create a centrally managed text skill |
| `GET` | `/api/settings/skills/{id}` | Read a text skill |
| `PATCH` | `/api/settings/skills/{id}` | Update a text skill |
| `DELETE` | `/api/settings/skills/{id}` | Delete a text skill |
| `GET` | `/api/agents/{agentId}/skills` | Read an agent skill assignment and effective catalog |
| `PUT` | `/api/agents/{agentId}/skills` | Replace an agent skill assignment |
| `GET` | `/api/settings/timezone` | Read operator timezone for agent context and schedule defaults |
| `PUT` | `/api/settings/timezone` | Save IANA operator timezone without changing browser-local UI or existing schedules |
