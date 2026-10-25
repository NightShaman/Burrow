# Agents and setup


!!! note "Source-reviewed API reference"
    This reference was reconciled against current development source on **2026-10-25**. Historical public-source links below remain pinned to their stated revision; they are not proof that a public mirror or your installation has caught up. Start with the [current operator guide](../../guide/installation.md) for installation. This is static source review, not a live API compatibility test.


The agent registry is PostgreSQL-backed. An empty registry is valid; a fallback agent label in code does not establish that a real agent exists. Start with `GET /api/setup/status` and `GET /api/agents`.

## Initial setup

Setup status distinguishes `fresh`, `incomplete` and `ready`. `POST /api/setup/complete` evaluates persisted operator identity and agent state; client-supplied flags do not establish completion. A model selection is not required merely to complete setup, but is required for normal model-backed chat.

Use the [initial setup guide](../../getting-started/initial-setup.md). The current wizard calls `POST /api/setup/operation` with an `operationId`, operator identity, agent, agent identity, a documents array and optional model selection. These durable stages share one transaction. A completed operation can be replayed with the same ID and identical input; changed input with that ID conflicts.

The current wizard sends all six profile kinds. Before retrying its known retained legacy five-kind submission, it inserts empty `PREFERENCES` and persists that repair while preserving the operation ID and every other field. Complete retained submissions replay unchanged. Profile validation failures roll back the operation's writes and do not record a replay ID; a changed payload against an already committed ID conflicts. Separately created provider connections are outside the transaction. See the [recovery procedure](../../operations/troubleshooting.md#first-run-profile-error).
## Registry

Create requires `name`; an optional `id` must be a string and pass registry validation. Update supported identity/configuration fields through PATCH; deleting an agent affects its related store records, so treat it as a destructive administrative action. Disabling an agent is separate from deletion.

`GET /api/agents` includes disabled agents unless `includeDisabled=false`. `POST /api/agents/overview` is a bulk UI projection with normalized request selection; it does not launch agents. `GET /api/agent-status` is listed under [diagnostics](diagnostics.md).
## Profile documents

The six kinds are `SOUL`, `RULES`, `ORIENTATION`, `PREFERENCES`, `TOOLS` and `DREAM_MEMORY`. Each is at most 48,000 characters. GET returns the persisted documents; PUT replaces a complete set and requires all six, rather than merging an arbitrary one-document patch. Preserve the other current documents when preparing a replacement.

These documents live in PostgreSQL, even when rendered with file-like names or `postgres:` references. Descriptive tool/profile text is not an MCP grant. Per-agent [model selection and MCP/skill assignments](settings.md) have separate endpoints; [Dream settings](memory.md#dream-controls) also have separate routes.
## Shared profiles

Current source implements shared `RULES` and `ORIENTATION` documents with per-agent `useGlobalRules` and `useGlobalOrientation` flags, through `GET`/`PUT /api/settings/global-profile-documents`. These settings first arrived after historical public 2026.10.19; older installations need an update before clients can rely on them.

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

## Targeted source review

The full page was reconciled on **2026-10-25** against Backend commit `3bf50374d3601c821e787912d52b9044eaf649ec`. No live API or provider calls were performed. The links below are retained historical public references, not links to the current development source.

- [backend/src/agent-profile-store.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/agent-profile-store.mjs)
- [backend/scripts/ui/agent-routes.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/scripts/ui/agent-routes.mjs)
