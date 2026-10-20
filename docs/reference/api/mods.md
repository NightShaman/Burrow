# Mods

Mods are trusted installed server/UI code. Distribution, activation, tool grants, and application data are separate lifecycles. Authors should use the current [third-party mod contract](../../development/mod-contract.md) and public [Burrow Reference Mod](https://github.com/NightShaman/Burrow-Reference-Mod).

## Catalog and management

`GET /api/mods` lists loaded/disabled/failed hosts, optional error/version, and declared UI contributions. `GET /api/mod-management` includes installed/available distribution state.

Management supports adding/removing sources, refresh, install/update, enable, disable, and uninstall. Fresh installs start disabled; update preserves lifecycle state. Installation grants no agent tools.

Sources use validated Git URLs, tagged manifests, and checked archives. Core chooses the highest accepted version tag; explicit requested version must match it. Source refresh does not auto-install updates.

Uninstall preserves mod settings, encrypted secrets, and `mods/mod-data/<id>`. Active lifecycle changes can be refused while busy.

## Routes and assets

Loaded mods register JSON routes beneath `/api/mods/{modId}` with GET/POST/PUT/PATCH/DELETE. Each mod owns its route contract. Control, Settings, and Archive UI assets use the same namespace.

Core auth runs before dispatch. Handlers receive trusted `auth.enabled`/`auth.authenticated`; credential headers are stripped. Mods validate input and enforce domain authorization. Generic responses are JSON, not streaming/binary. Normal deadline is 30 seconds; timeout returns 504 and revokes host availability.

## Tools and diagnostics

Tools publish under `mod.<id>` through existing MCP discovery/grants; no network MCP connection is needed. Default tools require explicit per-agent grant. Diagnostics require explicit opt-in and expose sanitized read-only projections.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/mods` | Loaded host catalog |
| `GET` | `/api/mod-management` | Installed/available catalog |
| `GET/PUT` | `/api/mod-management/source-refresh` | Source refresh settings |
| `POST` | `/api/mod-management/sources` | Add and inspect a source |
| `DELETE` | `/api/mod-management/sources/{sourceId}` | Remove a source |
| `POST` | `/api/mod-management/refresh` | Refresh configured sources |
| `POST` | `/api/mod-management/{modId}/install` | Install/update |
| `POST` | `/api/mod-management/{modId}/enable` | Enable |
| `POST` | `/api/mod-management/{modId}/disable` | Disable |
| `POST` | `/api/mod-management/{modId}/uninstall` | Uninstall while preserving settings/data |
