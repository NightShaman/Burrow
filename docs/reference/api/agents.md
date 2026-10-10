# Agents and setup

The agent registry is PostgreSQL-backed. An empty registry is valid; a fallback agent label in code does not establish that a real agent exists. Start with `GET /api/setup/status` and `GET /api/agents`.

## Initial setup

Setup status distinguishes `fresh`, `incomplete` and `ready`. `POST /api/setup/complete` evaluates persisted operator identity and agent state; client-supplied flags do not establish completion. A model selection is not required merely to complete setup, but is required for normal model-backed chat.

Use the [initial setup guide](../../getting-started/initial-setup.md). The current wizard calls `POST /api/setup/operation` with an `operationId`, operator identity, agent, agent identity, a documents array and optional model selection. These durable stages share one transaction. A completed operation can be replayed with the same ID and identical input; changed input with that ID conflicts.

The wizard still sends five profile kinds against a six-kind backend contract. This now rolls back the operation's writes, rather than leaving a newly created agent behind. Separately created provider connections are outside the transaction. See the [fresh-install recovery procedure](../../operations/troubleshooting.md#first-run-profile-error).

[Current setup operation](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/setup-operation.mjs).

[Setup state](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-setup-state-store.mjs) · [Setup routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/ui/settings-routes.mjs)

## Registry

Create requires `name`; an optional `id` must be a string and pass registry validation. Update supported identity/configuration fields through PATCH; deleting an agent affects its related store records, so treat it as a destructive administrative action. Disabling an agent is separate from deletion.

`GET /api/agents` includes disabled agents unless `includeDisabled=false`. `POST /api/agents/overview` is a bulk UI projection with normalized request selection; it does not launch agents. `GET /api/agent-status` is listed under [diagnostics](diagnostics.md).

[Registry routes](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/ui/agent-routes.mjs) · [Registry storage](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-agent-registry.mjs)

## Profile documents

The six kinds are `SOUL`, `RULES`, `ORIENTATION`, `PREFERENCES`, `TOOLS` and `DREAM_MEMORY`. Each is at most 48,000 characters. GET returns the persisted documents; PUT replaces a complete set and requires all six, rather than merging an arbitrary one-document patch. Preserve the other current documents when preparing a replacement.

These documents live in PostgreSQL, even when rendered with file-like names or `postgres:` references. Descriptive tool/profile text is not an MCP grant. Per-agent [model selection and MCP/skill assignments](settings.md) have separate endpoints; [Dream settings](memory.md#dream-controls-missing-from-the-pinned-openapi) also have separate routes.

[Profile contract](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/agent-profile-store.mjs) · [Complete replacement](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-agent-profile-store.mjs)


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
| `POST` | `/api/setup/complete` | Mark installation setup complete after checking persisted requirements |
| `POST` | `/api/setup/operation` | Transactional, replay-safe complete first-run setup |
| `POST` | `/api/agents/overview` | Read bulk agent UI overview |
