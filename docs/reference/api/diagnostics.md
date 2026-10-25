# Health and diagnostics


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-10-25**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


Health, operational projections and conversation/trace evidence expose different levels of information. A read-only route is not necessarily content-free, and an HTTP success is not proof that a full model/tool workflow succeeded.

## Health and metrics

`GET /health` and `GET /api/health` both precede authentication and return minimal build identity: `ok: true`, `runtime: "burrow"`, `version`, `buildIdentity`, and optional release provenance. A configured smoke token is echoed only on a matching `x-burrow-smoke-token` request. These are liveness/build checks, not full database/model readiness or detailed runtime configuration. Host checks and applicable browser-origin checks run before these routes.

`GET /api/status` remains gated and returns detailed runtime status, including roots and model/policy/trace metadata. Its payload can have `ok: false` despite HTTP 200.
`/api/metrics` returns bounded operational metrics. `/api/diagnostics/inventory` exposes only configured MCP and installed/enabled mod counts. `/api/diagnostics/postgres` reports PostgreSQL availability and pgvector installation without exposing its password. See [observability](../../operations/observability.md).
## Traces and authority

List traces for `agentId` and `sessionId` (default `default`). Detail uses `runId`; `output=true` requests tool output in the summary. The `/authority` child route returns an execution explanation with tool output disabled. These are evidence inspections, not additional approvals or grants.

Traces and context/session endpoints can contain private user or tool content. Review before sharing and do not confuse output truncation with secret redaction.

## Narrow diagnostic projections

Forge diagnostics list uses `limit` (default 50) and opaque `cursor`; UUID job detail exposes safe job summary fields, not prompts, credentials, output bytes or the full generation response.

Mod diagnostics list reports opt-in status. Job list/detail uses the extension's bounded sanitized diagnostic capability; `/pending` shows active host capability operations. Unsupported and unavailable diagnostics are distinct from an empty successful list. These routes do not run arbitrary mod GET handlers.
## Brain diagnostic metadata

`GET /api/diagnostics/brains` returns global or optional `agentId` counts and embedding status. `/api/diagnostics/brains/memories` requires `agentId`; `/api/diagnostics/brains/embedding-jobs` permits global or agent scope. The two lists accept positive `limit` (default 50) and a server-issued cursor bound to scope and list type. Unknown/duplicate query fields are rejected, and the summary does not accept pagination.

These projections exclude saved-memory text, source references, vectors, legacy snapshots, connection IDs and raw provider errors. Counts and record metadata remain operational information. They are included in the public `diagnostics:read` allowlist.

## Scoped Bearer clients

`diagnostics:read` tokens are accepted only for the exact GET allowlist in [authentication](../../security/authentication.md). That list also permits selected agents/sessions/context/traces/archive reads, which can expose conversational evidence. It does not permit workspace files, model/MCP settings, exports, Forge artifact bytes/generation or arbitrary mod routes.

Do not describe the whole token scope as content-free merely because inventory and Forge/mod summary projections are narrower.

## Provider usage helpers

Codex-LB accounts and Anthropic/OpenAI OAuth usage are integration-specific interactive-auth endpoints. OAuth usage accepts `connectionId` and `force=true`; its ordinary cache interval is 60 seconds. These helpers depend on provider compatibility and available credentials and are not granted by a diagnostics Bearer token. Failure is not proof that ordinary chat is broken.
## Auth flow endpoints

The contract includes `GET /api/auth/session`. Source also implements:

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/auth/discovery` | Public auth mode and enabled flag |
| `GET` | `/api/auth/validate` | Gated validation; HTTP 401 when auth is disabled |
| `GET` | `/auth/oidc/login` | Begin configured OIDC authorization |
| `GET` | `/auth/oidc/callback` | Validate callback and set session cookie |
| `POST` | `/auth/logout` | Clear OIDC and Basic cookies |

Discovery, session inspection, OIDC login/callback and logout precede the main gate; validation follows it. Session inspection remains OIDC-specific. Logout clears the Basic cookie too, but a client still sending Basic credentials can authenticate again. Follow [authentication](../../security/authentication.md) for state/nonce/cookie behavior.

## Endpoint inventory

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Public minimal build identity |
| `GET` | `/api/health` | Public minimal build identity |
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
| `GET` | `/api/diagnostics/brains` | Read Brain counts and embedding status |
| `GET` | `/api/diagnostics/brains/memories` | Read per-agent saved-memory metadata |
| `GET` | `/api/diagnostics/brains/embedding-jobs` | Read embedding job metadata |
| `GET` | `/api/diagnostics/forge/jobs` | List sanitized Forge job summaries |
| `GET` | `/api/diagnostics/forge/jobs/{jobId}` | Read sanitized Forge job summary |

## Targeted source review

The full page was reconciled on **2026-10-25** against Backend commit `3bf50374d3601c821e787912d52b9044eaf649ec`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/scripts/burrow-ui.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/burrow-ui.mjs)
- [backend/src/brain-diagnostic-summary.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/brain-diagnostic-summary.mjs)
