# Mods


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-10-25**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


Mods are trusted installed server/UI code. Distribution, activation, tool grants and application data are separate lifecycles. See [extension development](../../development/extensions.md) and [trust boundaries](../../security/trust-boundaries.md) before installing a source.

## Catalog and management

`GET /api/mods` is the loaded/disabled/failed host catalog, including status, optional error/version and declared UI contributions. It is not equivalent to `GET /api/mod-management`, which includes installed and available distribution information. Failed/disabled entries can remain visible without active routes/tools.

The management API supports adding/removing sources, refreshing release discovery, install/update, enable, disable and uninstall. A fresh install starts disabled; update preserves lifecycle state. Installation does not automatically grant agent tools.

Sources use validated Git URLs, tagged manifests and checked archives. The current installer chooses the latest accepted version tag; an explicit requested version must match that latest release. Do not assume arbitrary historical pin/rollback selection. Source discovery is not auto-update installation. Background refresh is normally every six hours, with stale checks/backoff; read/save its persisted settings through `/source-refresh`.

Uninstall refuses system mods and preserves mod settings, encrypted secrets and `mods/mod-data/<id>`. Removing source metadata and uninstalling code are separate actions. Active lifecycle changes can be refused while the mod is busy; inspect the response rather than retrying destructive transitions blindly.
## Operator-owned system capability access

`GET`/`PUT /api/operator/mods/{modId}/access` reads or replaces `grants`, `adminAgentIds` and `diagnosticAgentIds`. Supply all three arrays on replacement; grants must be declared by that mod and supported by Core. A manifest alone does not grant system capabilities. The response includes `declaredCapabilities` and reports `restartRequired` after a save.

Current source accepts authenticated operator requests when UI authentication is enabled and direct operator requests in `none` mode. API tokens remain rejected. Historical public 2026.10.19 required an authenticated operator even in `none` mode; do not apply that older exception to the current implementation.

## Mod-specific routes and assets

Enabled loaded mods can register JSON HTTP routes beneath `/api/mods/{modId}/…` using GET, POST, PUT, PATCH or DELETE. They are not enumerable from the core OpenAPI artifact: each installed extension supplies its own route contract. Declared Control, Settings and Archive UI entry points/assets use the same namespace.

Core authentication runs before dispatch. The mod receives trusted `auth.enabled`/`auth.authenticated` booleans; authorization, cookie, proxy-authorization and x-api-key headers are removed from the projected request. A route's own handler must validate arguments and enforce domain-specific authorization. GET is not automatically side-effect-free.

The host returns JSON, not a generic binary/streaming response contract. Route deadline is normally 30 seconds; timeout returns 504 and revokes availability. A disconnected/unavailable host returns 503; handler failures use `mod_route_failed`. This child-process boundary limits lifecycle/failure propagation, not operating-system permissions.
## Diagnostics and tools

Mod diagnostics require an explicit opt-in capability and expose a narrow sanitized projection, separate from arbitrary mod GET routes. See [diagnostics](diagnostics.md). Agent tools are registered under `mod.<id>` and use the [MCP catalog/grants](../../concepts/mcp.md#mod-tools-use-the-same-grant-surface), without opening a network MCP endpoint.

## Endpoint inventory

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/mods` | List loaded mods and host contributions |
| `GET` | `/api/operator/mods/{modId}/access` | Read operator-owned system capability grants |
| `PUT` | `/api/operator/mods/{modId}/access` | Replace operator-owned system capability grants |
| `GET` | `/api/mod-management` | List installed and available mods |
| `GET` | `/api/mod-management/source-refresh` | Read persisted mod source refresh settings |
| `PUT` | `/api/mod-management/source-refresh` | Replace persisted mod source refresh settings |
| `POST` | `/api/mod-management/sources` | Add and inspect a mod source |
| `DELETE` | `/api/mod-management/sources/{sourceId}` | Remove a mod source |
| `POST` | `/api/mod-management/refresh` | Refresh all mod sources |
| `POST` | `/api/mod-management/{modId}/install` | Install or update a mod |
| `POST` | `/api/mod-management/{modId}/enable` | Enable an installed mod |
| `POST` | `/api/mod-management/{modId}/disable` | Disable an installed mod |
| `POST` | `/api/mod-management/{modId}/uninstall` | Uninstall a mod while preserving settings |

## Targeted source review

The full page was reconciled on **2026-10-25** against Backend commit `3bf50374d3601c821e787912d52b9044eaf649ec`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/src/mod-authority.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/mod-authority.mjs)
- [backend/src/mod-distribution.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/mod-distribution.mjs)
- [backend/src/mod-runtime.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/mod-runtime.mjs)

## External agent turns with images

Current Core's host capability `context.agents.turns.submit` accepts optional `attachments` beside `agentId`, `sessionId`, `message`, optional `displayMessage`, and `idempotencyKey`. This is an internal mod capability, not a new public HTTP route. Attachments use normal ChatAttachment fields (`name`, `type` or `mimeType`, `size`, `encoding`, `content`); actual nonempty content is required. Images must be matching `data:image/...;base64,...` content with canonical padded base64, never provider download URLs, private storage paths or credentials.

Core normalizes before durable acceptance and rejects dropped/truncated or malformed input. Image content is limited to 30,000,000 characters including the data URL prefix; non-image content beyond 200,000 characters is rejected. Provider/model limits still apply. Normalized bytes persist with the durable receipt and normal agent attachment artifacts. Submit/read/cancel public projections omit those submitted payloads.

Idempotency compares normalized attachment content and metadata as well as agent/session/message/display input. Omitted attachments and `[]` are equivalent; changing attachments under an existing key returns `mod_external_turn_idempotency_conflict`. A vision-capable selected model receives the actual image; otherwise the ordinary chat vision fallback applies. Update Core before enabling a transport feature that depends on this capability. See [Tutor external-turn lesson](https://docs.goblin-kingdom.com/burrow-tutor/advanced/external-agent-turns/).

Source reviewed on **31 October 2026** against Core `8275b6bedf1fcd969fb5289cf0b673a80ddc8146`; no transport/provider call was performed.
