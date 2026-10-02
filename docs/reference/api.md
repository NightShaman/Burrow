# HTTP API

The API serves BURROW's UI and external clients. It is an operator-level control surface: it can create agents, change credentials and grants, execute model/tool work, import data and delete retained content. Read [authentication](../security/authentication.md) and [trust boundaries](../security/trust-boundaries.md) before exposing it.

## Browse by family

| Reference | Covers |
|---|---|
| [Chat and streaming](api/chat.md) | Turn submission, NDJSON events, cancellation and reconnection |
| [Agents and setup](api/agents.md) | Registry, profile documents, initial setup |
| [Sessions and Archive](api/sessions.md) | Current/original history, reset/fork/archive, context, handoffs |
| [Tasks, schedules and groups](api/work.md) | Task board, recurring jobs, group chat, legacy workbench |
| [Settings and integrations](api/settings.md) | Auth, models/OAuth, MCP grants, skills, timezone, retention, API tokens |
| [Memory and Dreams](api/memory.md) | Albdruck, original recall, purge, Tiddle, Dream controls |
| [Files, Forge and exports](api/artifacts.md) | Workspace editing, attachments, generated artifacts, selective export/import |
| [Mods](api/mods.md) | Distribution, lifecycle, extension routes and UI assets |
| [Health and diagnostics](api/diagnostics.md) | Health, metrics, traces, diagnostic projections and provider usage |

## Contract download and provenance

[Download the pinned OpenAPI JSON](../assets/reference/openapi-2026.08.25.json)

| Property | Value |
|---|---|
| Specification | OpenAPI `3.1.0` |
| Contract `info.version` | `2026.08.25` |
| Inventory | 150 paths, 193 operations, 112 component schemas |
| Contract artifact source revision | Backend `b20376440086340e8746507ca700a4cd9e07bf96` |
| Documented assembled baseline | `2026.10.02.7`, commit `2d979fecca8434fe02a6ed2e8225c46eb4690098` |
| SHA-256 | `e91eb15cd7a4c17d3a104aee6156ff8c559ad4306ae53c7aaf90492dca4ae564` |

The download is the unchanged contract from the fully inspected `.6` Backend snapshot. The `.7` assembled delta does not contain a replacement contract; this site does not claim to have retrieved a newer upstream schema. Current route behavior is checked against the frozen `.7` public source. The pages above reconcile implementation behavior and add implemented routes absent from it. The [route index](../assets/reference/api-route-index.json) maps contract operations and documented source additions to their reference pages. It is a documentation coverage aid, not a runtime-generated discovery API.

!!! warning "The schema is incomplete"
    It has no authentication security schemes, omits seven Dream operations and the non-API OIDC/logout routes, and contains broad open-object schemas. Its Forge request/catalog and mod-catalog shapes lag implementation. Do not infer anonymous access, unsupported features or complete client compatibility from generated types alone.

Specific drift:

- Dream settings, diary, consolidation and cycle routes are documented from the current route module
- Mod catalog responses also carry lifecycle status, failure information, version and Archive UI contributions
- Forge accepts mode-based selection; its source artifact still requires an explicit connection/model pair and omits the `mode` property
- Music availability is catalog-dependent; it is not unconditionally false as the old schema states
- Forge jobs can include bounded `errorDetails`; the old job schema omits them
- Archive calendar uses the requested timezone, despite its old UTC-only summary

The source drift checker scans literal route comparisons. Passing it does not establish dynamic-route, HTTP-method, request or response parity. See [known limitations](../project/known-limitations.md).

[Dream routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/dream-routes.mjs#L1-L27) · [Mod catalog](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/mod-runtime.mjs#L295-L307) · [Forge input](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-forge-store.mjs#L270-L334)

## Runtime explorer

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/docs` | Locally vendored Scalar explorer shell |
| `GET` | `/api/docs/{asset}` | Explorer assets |
| `GET` | `/api/openapi.json` | Source-tree OpenAPI document |

These routes are behind the usual authentication gate. The schema endpoint reads `backend/docs/openapi.json` within the installed Backend source tree.

That file is absent from this public assembled snapshot. The explorer shell can load while its contract request fails. The download on this documentation site does not change that runtime behavior. The same omitted source assets can affect API-contract export categories.

[Explorer routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L3225-L3239)

## Request conventions

- Base URL is the actual service origin, commonly `http://127.0.0.1:42817` for a native loopback installation
- JSON requests use `Content-Type: application/json`; empty bodies are parsed as `{}`
- Supply real `agentId` and `sessionId` values rather than relying on default-agent resolution in automation; `default` is a common session default
- Identity in a route/query/body selects an application object. It is not a separate authentication principal or tenant boundary
- Most JSON routes return an `ok` field, but this is not universal; Albdruck and byte-download endpoints differ
- Check both HTTP status and the endpoint's application outcome. HTTP 200, a run ID or a queued response alone does not prove successful execution
- Pagination conventions differ: opaque `cursor`, transcript `before`/`from`/`to`, or simple `limit`. Follow each endpoint and do not manufacture cursors
- There is no general HTTP API version prefix, universal idempotency header or WebSocket protocol in this surface. Forge has a body-level idempotency contract

Invalid JSON returns `400 invalid_json`. Selected route boundaries reject non-object bodies and required fields; the server does not apply a universal OpenAPI request validator. General JSON ingestion buffers the request body before parsing. Apply deployment-level request limits as appropriate.

[Parsing/validation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L1835-L1873) · [Route composition and errors](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L3151-L3289)

## Authentication for clients

Use the configured Basic, trusted-proxy or OIDC session flow for the full API. Scoped Bearer tokens currently support only `diagnostics:read` and an exact GET allowlist; they cannot administer settings or run chat. A rejected Bearer token returns 403 rather than falling back to interactive authentication.

`GET /health` is public and contains runtime metadata. `/api/health` is gated. `GET /api/auth/session` reports OIDC-session presence, not a general Basic/proxy introspection result. See the [complete authentication reference](../security/authentication.md).

## Minimal read example

For a loopback development service with authentication explicitly disabled:

```sh
curl --fail-with-body http://127.0.0.1:42817/api/agents
```

For Basic authentication, add `--user "$BURROW_USERNAME"` and let curl prompt for the password. Do not embed passwords or tokens in command history, URLs, source files or documentation examples. Use your deployment's configured authentication for all other examples.
