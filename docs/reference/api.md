# HTTP API


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-10-25**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


The API serves BURROW's UI and external clients. It is an operator-level control surface: it can create agents, change credentials and grants, execute model/tool work, import data and delete retained content. Read [authentication](../security/authentication.md) and [trust boundaries](../security/trust-boundaries.md) before exposing it.

## Browse by family

| Reference | Covers |
|---|---|
| [Chat and streaming](api/chat.md) | Turn submission, NDJSON events, cancellation and reconnection |
| [Agents and setup](api/agents.md) | Registry, profile documents, initial setup |
| [Sessions and Archive](api/sessions.md) | Current/original history, reset/fork/archive, context, handoffs |
| [Tasks, schedules and groups](api/work.md) | Task board, recurring jobs, group chat, legacy workbench |
| [Settings and integrations](api/settings.md) | Auth, models/OAuth, MCP grants, skills, timezone, retention, API tokens |
| [Memory and Dreams](api/memory.md) | Brains, explicit conversation recall, Tiddle, Dream controls |
| [Files, Forge and exports](api/artifacts.md) | Workspace editing, attachments, generated artifacts, selective export/import |
| [Mods](api/mods.md) | Distribution, lifecycle, extension routes and UI assets |
| [Health and diagnostics](api/diagnostics.md) | Health, metrics, traces, diagnostic projections and provider usage |

## Contract source and provenance

[Read the public-release OpenAPI JSON](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/docs/openapi.json)

| Property | Value |
|---|---|
| Specification | OpenAPI `3.1.0` |
| Contract `info.version` | `2026.08.25` (retained schema label, not the release date) |
| Public source inventory | 176 paths, 232 operations, 121 component schemas |
| Reviewed public release | `2026.10.19` |
| Reviewed public commit | `aa5a30da683a3a8ea919025f107ff53f182ef8d6` |
| SHA-256 | `67d27fbc347c78ab56671f466733a87bb7d916366adec5ba8bb83f1cc6d8f726` |

The public assembly includes `backend/docs/openapi.json`. Its contract includes Brains, Dream controls, Git-skill management, Minion model selection, task history/attachments and OpenTelemetry settings. Retired `/api/albdruck/*` routes are absent. The source-backed endpoint pages still need to be read alongside the schema: its inventory is not proof of request/response parity or live compatibility.

The current development contract reviewed on **2026-10-27** has **190 paths, 252 operations and 153 component schemas**, including durable chat inputs, workflow events and Dream memory preview. Its SHA-256 is `0248d7096350b0d035b99af2ec6041955a6dccd091c24c634fbbda8625f01285`; `info.version` remains `2026.08.25`. The table above describes the historical public artifact, not the current development inventory. Use the schema served by your installation and check the source-reviewed family pages for implementation details.


!!! warning "The schema is incomplete"
    The current schema declares the GitHub webhook signature scheme, but not the ordinary interactive UI authentication modes. It omits non-API OIDC/logout routes and contains broad open-object schemas. Its Forge request/catalog and mod-catalog shapes lag implementation. Do not infer anonymous access, unsupported features or complete client compatibility from generated types alone.


Specific drift:

- Mod catalog responses also carry lifecycle status, failure information, version and Archive UI contributions
- Forge accepts mode-based selection; its source artifact still requires an explicit connection/model pair and omits the `mode` property
- Music availability is catalog-dependent; it is not unconditionally false as the old schema states
- Forge jobs can include bounded `errorDetails`; the old job schema omits them
- Archive calendar uses the requested timezone, despite its old UTC-only summary
- Native OAuth pool settings and metrics now have schema coverage, but the model-connection description still says union while current runtime catalogs use the intersection of non-manual member models
- The operator mod-access route is source-implemented but absent from this schema

The source drift checker scans literal route comparisons. Passing it does not establish dynamic-route, HTTP-method, request or response parity. See [known limitations](../project/known-limitations.md).
## Runtime explorer

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/docs` | Locally vendored Scalar explorer shell |
| `GET` | `/api/docs/{asset}` | Explorer assets |
| `GET` | `/api/openapi.json` | Source-tree OpenAPI document |

These routes are behind the usual authentication gate. The schema endpoint reads `backend/docs/openapi.json` within the installed Backend source tree.

That file is present in the reviewed public assembly. Its presence and static route wiring were verified; the explorer and API-contract export have not been exercised against a live deployment.

## Request conventions

- Base URL is the actual service origin, commonly `http://127.0.0.1:42817` for a native loopback installation
- JSON requests use `Content-Type: application/json`; empty bodies are parsed as `{}`
- Supply real `agentId` and `sessionId` values rather than relying on default-agent resolution in automation; `default` is a common session default
- Identity in a route/query/body selects an application object. It is not a separate authentication principal or tenant boundary
- Most JSON routes return an `ok` field, but this is not universal; some memory and byte-download endpoints differ
- Check both HTTP status and the endpoint's application outcome. HTTP 200, a run ID or a queued response alone does not prove successful execution
- Pagination conventions differ: opaque `cursor`, transcript `before`/`from`/`to`, or simple `limit`. Follow each endpoint and do not manufacture cursors
- There is no general HTTP API version prefix, universal idempotency header or WebSocket protocol in this surface. Forge has a body-level idempotency contract

Invalid JSON returns `400 invalid_json`. Selected route boundaries reject non-object bodies and required fields; the server does not apply a universal OpenAPI request validator. JSON ingestion is bounded before parsing; route families can impose stricter limits. Browser-origin and JSON content-type checks apply to mutations. These checks do not replace authentication or deployment-level request limits. See [trust boundaries](../security/trust-boundaries.md).
## Authentication for clients

Use the configured Basic, trusted-proxy or OIDC session flow for the full API. Scoped Bearer tokens currently support only `diagnostics:read` and an exact GET allowlist; they cannot administer settings or run chat. A rejected Bearer token returns 403 rather than falling back to interactive authentication.

`GET /health` and `GET /api/health` are both public minimal build-identity routes; `/api/status` is gated. `GET /api/auth/session` reports OIDC-session presence, not a general Basic/proxy introspection result. See the [complete authentication reference](../security/authentication.md).

## Minimal read example

For a loopback development service with authentication explicitly disabled:

```sh
curl --fail-with-body http://127.0.0.1:42817/api/agents
```

For Basic authentication, add `--user "$BURROW_USERNAME"` and let curl prompt for the password. Do not embed passwords or tokens in command history, URLs, source files or documentation examples. Use your deployment's configured authentication for all other examples.

## Targeted source review

The full page was reconciled on **2026-10-25** against Backend commit `3bf50374d3601c821e787912d52b9044eaf649ec`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/docs/openapi.json](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/docs/openapi.json)
- [backend/scripts/burrow-ui.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/burrow-ui.mjs)

## 26 October delta review

Updated against Backend `4df4b424e2b2856cb2c25c8464da7f806eb661e0` on **2026-10-26**. This is a focused source comparison since the full review above, not a new application or provider test pass.

## 27 October delta review

Changed contracts checked statically against Backend `32ff99dfc0317635f5c7aa53b4c9ec18266d4c09` on **2026-10-27**. This does not recertify unchanged historical sections or report live API/provider tests.
