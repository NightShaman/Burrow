# Health and diagnostics


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-10-25**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


Health, operational projections and conversation/trace evidence expose different levels of information. A read-only route is not necessarily content-free, and an HTTP success is not proof that a full model/tool workflow succeeded.

## Health and metrics

`GET /health` and `GET /api/health` both precede authentication and return minimal build identity: `ok: true`, `runtime: "burrow"`, `version`, `buildIdentity`, and optional release provenance. A configured smoke token is echoed only on a matching `x-burrow-smoke-token` request. These are liveness/build checks, not full database/model readiness or detailed runtime configuration. Host checks and applicable browser-origin checks run before these routes.

`GET /api/status` remains gated and returns detailed runtime status, including roots and model/policy/trace metadata. Its payload can have `ok: false` despite HTTP 200.
`/api/metrics` returns bounded operational metrics. `/api/diagnostics/inventory` exposes only configured MCP and installed/enabled mod counts. `/api/diagnostics/postgres` reports PostgreSQL availability and pgvector installation without exposing its password. See [observability](../../operations/observability.md).
## Descendant status

`GET /api/agent-status?agentId=...&sessionId=...` returns the requested session and scoped descendants. Entries include `sessionId`, nullable `runId`, `subagentId`, immediate `parentSessionId`/`parentRunId`, `rootSessionId`/`rootRunId`, `depth` and `maxDepth`. Roots are depth 0, children 1, grandchildren 2. A child-scoped read excludes siblings; ancestor-first ordering retains ended ancestors needed to connect visible descendants. Missing parent records do not authorize inventing a new root: recorded orphan ancestry is preserved.

`GET /api/chat/runs/active` and `POST /api/agents/overview` use the same scoped lineage. Overview hydrates context for the requested session plus at most 12 descendants and reports omitted **contexts**, not a truncated status tree. Live descendants can remain visible from persisted session metadata even without a retained child receipt file.

Root `maxDepth` reflects the current setting; child `maxDepth` is its saved spawn-time budget, not permission to spawn now. Statuses include `THINKING`, `STREAMING`, `VERIFYING`, `CANCELLING`, `DONE`, `ERROR` and `IDLE`. Structured incomplete outcomes remain distinct from actual execution errors. These projections are observability, not execution authorization.

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
## Native OpenAI LB metrics

`GET /api/metrics/provider-pools` returns `{ok: true, windows: {"24h": window, "7d": window}}` for rolling database-time windows, attributed by logical completion. It uses normal authentication and is also in the `diagnostics:read` GET allowlist. Only native **OpenAI LB** contributes these receipts; Anthropic pools and direct model traffic do not.

Each window reports logical requests/successes/failures/cancellations, provider attempts/retries, summed duration, token totals, cache/error percentages and coverage counts. A retry is another attempt, not another logical request; successful failover is success. Error percentage is final failures divided by all completed requests, including cancellations in the denominator. Zero requests gives null. Unfinished requests are excluded from completed-window denominators.

Known token counts are summed over all attempts, including failures. Unknown usage remains null, not zero. Cache percentage uses only attempts with both input and cached counts; a zero or unknown denominator yields null. Inspect `coverage.inputAttempts`, `outputAttempts`, `cachedAttempts`, `cacheAttempts` and `cacheInputTokens` before treating partial data as complete measurement. See [observability](../../operations/observability.md) for the separate OpenTelemetry series.

## OpenAI rate-limit reset credits

`GET /api/openai/oauth/reset-credits?connectionId=...` reads provider-reported credit availability. `POST /api/openai/oauth/reset-credits/consume` takes `connectionId`, `creditId` and a stable `requestId`; it is an explicit operator action that can consume a provider credit, not a diagnostic health check or automatic LB action. These routes require normal interactive authentication, not a diagnostics Bearer token.

The service refreshes eligibility before dispatch and guards concurrent redemption for the same account. It does not retry the non-idempotent provider POST. Reusing a request ID with a different credit returns 409; repeat identity can replay the recorded result only within this process lifetime. An `ambiguous` result means the outcome is unknown: do not submit a fresh ID merely to retry. Check provider credit/usage state first; this is not a restart-durable redemption ledger. A successful redemption can carry failed `usageRefresh` or `creditsRefresh`; refresh failure does not mean redemption failed. Provider availability/entitlement is not guaranteed by route existence.

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
| `GET` | `/api/metrics/provider-pools` | Durable native OpenAI LB window metrics |
| `GET` | `/api/openai/oauth/reset-credits` | Read selected account reset credits |
| `POST` | `/api/openai/oauth/reset-credits/consume` | Explicitly redeem a selected reset credit |
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

## 26 October delta review

Updated against Backend `4df4b424e2b2856cb2c25c8464da7f806eb661e0` on **2026-10-26**. This is a focused source comparison since the full review above, not a new application or provider test pass.

## 29 October development delta

Changed contracts above were checked statically against Backend `4057b50a5d5a9b14d36bb3b70f35781c4b29a9b9` on **2026-10-29**. This is not a runtime, provider or collector test, nor a revalidation of unchanged historical sections. See [source coverage](../../project/source-map.md).
