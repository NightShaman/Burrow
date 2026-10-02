# Agents and setup

The agent registry is PostgreSQL-backed. An empty registry is valid; a fallback agent label in code does not establish that a real agent exists. Start with `GET /api/setup/status` and `GET /api/agents`.

## Initial setup

Setup status distinguishes `fresh`, `incomplete` and `ready`. `POST /api/setup/complete` evaluates persisted operator identity and agent state; client-supplied flags do not establish completion. A model selection is not required merely to complete setup, but is required for normal model-backed chat.

Use the [initial setup guide](../../getting-started/initial-setup.md). The current UI wizard's five-profile payload differs from the six-document replacement contract, so a failed final step may leave an already-created agent rather than a completely untouched installation.

[Setup state](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-setup-state-store.mjs#L15-L61) · [Setup routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/settings-routes.mjs#L9-L10)

## Registry

Create requires `name`; an optional `id` must be a string and pass registry validation. Update supported identity/configuration fields through PATCH; deleting an agent affects its related store records, so treat it as a destructive administrative action. Disabling an agent is separate from deletion.

`GET /api/agents` includes disabled agents unless `includeDisabled=false`. `POST /api/agents/overview` is a bulk UI projection with normalized request selection; it does not launch agents. `GET /api/agent-status` is listed under [diagnostics](diagnostics.md).

[Registry routes](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/ui/agent-routes.mjs#L1-L35) · [Registry storage](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-agent-registry.mjs#L51-L70)

## Profile documents

The six kinds are `SOUL`, `RULES`, `ORIENTATION`, `PREFERENCES`, `TOOLS` and `DREAM_MEMORY`. Each is at most 48,000 characters. GET returns the persisted documents; PUT replaces a complete set and requires all six, rather than merging an arbitrary one-document patch. Preserve the other current documents when preparing a replacement.

These documents live in PostgreSQL, even when rendered with file-like names or `postgres:` references. Descriptive tool/profile text is not an MCP grant. Per-agent [model selection and MCP/skill assignments](settings.md) have separate endpoints; [Dream settings](memory.md#dream-controls-missing-from-the-pinned-openapi) also have separate routes.

[Profile contract](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/agent-profile-store.mjs#L2-L47) · [Complete replacement](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-agent-profile-store.mjs#L46-L110)


## Endpoint inventory

Methods are significant. Braced segments are placeholders; URL-encode identifiers. See the [contract and conventions](../api.md) for artifact limitations.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/agents` | List registered agents |
| `POST` | `/api/agents` | Create a registered agent |
| `PATCH` | `/api/agents/{agentId}` | Update a registered agent |
| `DELETE` | `/api/agents/{agentId}` | Delete a registered agent |
| `GET` | `/api/agents/{agentId}/profile-documents` | Read agent profile documents |
| `PUT` | `/api/agents/{agentId}/profile-documents` | Replace agent profile documents |
| `GET` | `/api/setup/status` | Read persistent installation setup state |
| `POST` | `/api/setup/complete` | Mark installation setup complete |
| `POST` | `/api/agents/overview` | Read bulk agent UI overview |
