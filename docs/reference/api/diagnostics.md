# Health and diagnostics

Health, operational projections and conversation/trace evidence expose different levels of information. A read-only route is not necessarily content-free, and an HTTP success is not proof that a full model/tool workflow succeeded.

## Health and metrics

`GET /health` is before the authentication gate and returns runtime status including source/workspace metadata, selected model details and policy/trace status. Restrict it at the proxy when exposing the service. `/api/health` and `/api/status` return the corresponding gated status. A status payload can have `ok: false` despite HTTP 200.

`/api/metrics` returns bounded operational metrics. `/api/diagnostics/inventory` exposes only configured MCP and installed/enabled mod counts. `/api/diagnostics/postgres` reports PostgreSQL availability and pgvector installation without exposing its password. See [observability](../../operations/observability.md).

[Public/gated order](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L3151-L3170) · [Runtime status](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L2264-L2290) · [Inventory](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L3190-L3203)

## Traces and authority

List traces for `agentId` and `sessionId` (default `default`). Detail uses `runId`; `output=true` requests tool output in the summary. The `/authority` child route returns an execution explanation with tool output disabled. These are evidence inspections, not additional approvals or grants.

Traces and context/session endpoints can contain private user or tool content. Review before sharing and do not confuse output truncation with secret redaction.

[Trace routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/observability-routes.mjs#L13-L15)

## Narrow diagnostic projections

Forge diagnostics list uses `limit` (default 50) and opaque `cursor`; UUID job detail exposes safe job summary fields, not prompts, credentials, output bytes or the full generation response.

Mod diagnostics list reports opt-in status. Job list/detail uses the extension's bounded sanitized diagnostic capability; `/pending` shows active host capability operations. Unsupported and unavailable diagnostics are distinct from an empty successful list. These routes do not run arbitrary mod GET handlers.

[Diagnostic routing](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L3166-L3190) · [Mod sanitizer](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/mod-diagnostics.mjs#L1-L53)

## Scoped Bearer clients

`diagnostics:read` tokens are accepted only for the exact GET allowlist in [authentication](../../security/authentication.md). That list also permits selected agents/sessions/context/traces/archive reads, which can expose conversational evidence. It does not permit workspace files, model/MCP settings, exports, Forge artifact bytes/generation or arbitrary mod routes.

Do not describe the whole token scope as content-free merely because inventory and Forge/mod summary projections are narrower.

## Provider usage helpers

Codex-LB accounts and Anthropic/OpenAI OAuth usage are integration-specific interactive-auth endpoints. OAuth usage accepts `connectionId` and `force=true`; its ordinary cache interval is 60 seconds. These helpers depend on provider compatibility and available credentials and are not granted by a diagnostics Bearer token. Failure is not proof that ordinary chat is broken.

[Usage routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/observability-routes.mjs#L1-L9) · [Usage caches](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L146-L152)

## Auth flow endpoints

The contract includes `GET /api/auth/session`. Source also implements:

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/auth/oidc/login` | Begin configured OIDC authorization |
| `GET` | `/auth/oidc/callback` | Validate callback and set session cookie |
| `POST` | `/auth/logout` | Clear OIDC cookies |

These handlers precede the main gate. Session inspection is OIDC-specific and logout is not a general demonstrated Basic-session logout endpoint. Follow [authentication](../../security/authentication.md) for state/nonce/cookie behavior.

[Auth routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/auth-routes.mjs#L1-L28)


## Endpoint inventory

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Public runtime health |
| `GET` | `/api/health` | Authenticated runtime health |
| `GET` | `/api/status` | Runtime status |
| `GET` | `/api/metrics` | Bounded operational metrics |
| `GET` | `/api/diagnostics/inventory` | Safe diagnostics inventory counts |
| `GET` | `/api/traces` | List traces |
| `GET` | `/api/traces/{runId}` | Read a trace |
| `GET` | `/api/agent-status` | Read agent status |
| `GET` | `/api/traces/{runId}/authority` | Read trace authority |
| `GET` | `/api/auth/session` | Read auth session |
| `GET` | `/api/codex-lb/accounts` | List Codex-LB accounts |
| `GET` | `/api/anthropic/oauth/usage` | Read Anthropic OAuth usage |
| `GET` | `/api/openai/oauth/usage` | Read OpenAI OAuth usage |
| `GET` | `/api/diagnostics/mods` | Read sanitized opt-in mod diagnostics |
| `GET` | `/api/diagnostics/mods/{modId}/jobs` | Read sanitized opt-in mod diagnostics |
| `GET` | `/api/diagnostics/mods/{modId}/jobs/{jobId}` | Read sanitized opt-in mod diagnostics |
| `GET` | `/api/diagnostics/mods/{modId}/pending` | Read current mod capability operations |
| `GET` | `/api/diagnostics/postgres` | Read PostgreSQL availability and pgvector installation |
| `GET` | `/api/diagnostics/forge/jobs` | List sanitized Forge job summaries |
| `GET` | `/api/diagnostics/forge/jobs/{jobId}` | Read sanitized Forge job summary |
