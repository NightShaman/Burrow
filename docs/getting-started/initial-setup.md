# Initial setup

Complete setup from the local listener before exposing Burrow to other machines. Keep [authentication](../security/authentication.md) and the [settings encryption key](../reference/configuration.md) under operator control.

## First-run flow

The UI reads `/api/setup/status`. A `fresh` or `incomplete` installation opens **Settings → Agents** and the first-run dialog. The dialog has five stages:

1. Import an existing portable export, or start fresh
2. Enter the operator's displayed name and optional avatar
3. Choose the first agent's name and optional avatar
4. Write its personality/identity text for the `SOUL` profile document
5. Select a model connection and model, or configure one later

An import can replace conflicting portable records. Only use an export you trust, and review [export versus full backup](../operations/backup-recovery.md#portable-exports) before choosing that path.

Setup completion is based on persisted records: a nonempty operator name and at least one named agent. A model is optional for completing setup, but is needed for model-backed chat. Once completion is persisted, deleting the last agent does not automatically turn the installation back into a fresh setup.

!!! warning "Profile mismatch in the reviewed snapshot"
    The first-run dialog submits five profile kinds, while the backend requires six, including `PREFERENCES`. If Finish reports `agent_profile_documents_complete_set_required`, the operator and agent may already exist. Do not repeatedly create the same agent. Follow the [targeted recovery procedure](../operations/troubleshooting.md#first-run-profile-error). This documentation does not change the runtime implementation.

## Configure a usable model

Under **Settings → Connections → Model providers**, add or update the provider connection, supply credentials through the UI, and enable the exact models you want to use. Model discovery can fall back to manual configuration; an empty discovery list is not proof that the provider supports no models.

Select the saved connection/model for the intended agent under **Settings → Agents → Agent details**. A saved connection, an enabled model, and an agent model selection are separate records. The chat controls may also provide per-turn model, reasoning-effort, and temperature choices.

- Use a credential intended for this Burrow deployment
- Keep credentials out of profile text, screenshots, shell history, and shared logs
- Choose input/output capabilities matching the real provider and model
- Read [models](../concepts/models.md) for adapters and capability limits

## Review agent context

The regular profile editor exposes `SOUL`, `RULES`, `ORIENTATION`, `PREFERENCES`, `TOOLS`, and `DREAM_MEMORY`. These are PostgreSQL-backed profile records rendered as document-like context, not ordinary files that must be edited in the application tree.

Set an explicit agent identity and useful instructions. Avoid copying private host-specific paths or credentials into reusable profiles. Review [agents and minions](../concepts/agents-minions.md) and [memory](../concepts/memory.md) to understand what persists and what enters the next model request.

## Set operating preferences

- **Settings → General → Operator timezone:** choose the intended IANA timezone; inherited schedules follow it
- **Settings → Connections → Authentication:** configure the chosen authentication mode before remote access
- **Settings → Connections → MCP servers:** add only required integrations; assign permitted tools to the intended agent
- **Settings → General → Trace retention:** review retention and preview cleanup before destructive maintenance

Dream cycles and other background work can call providers after setup. Review agent Dream settings and scheduled jobs, especially on metered model accounts. See [Dreams](../concepts/dreams.md) and [workers and tasks](../concepts/workers-tasks.md).

## Verify one conversation

1. Open **Chat** and select the intended agent
2. Send a short, low-risk question
3. Confirm a complete answer arrives, with the expected model selected
4. Inspect the activity or [observability](../operations/observability.md) if a tool or model call fails
5. Reload the UI and confirm the conversation and selected runtime are still correct

A provider error, missing model selection, or incomplete stream is a failed verification even if the HTTP request itself returned 200. Do not grant broad tool access merely to make a basic chat test pass.

The main UI also has **Tasks**, **Archive**, **Albdruck**, **Forge**, and **Settings**. See the [interface guide](../concepts/interface.md) for their roles.

## Source evidence

- [Setup authority and completion requirements](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-setup-state-store.mjs)
- [UI setup routing](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/ui/src/App.tsx#L36-L49)
- [First-run dialog](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/ui/src/features/settings/AgentToolbar.tsx#L8-L208)
- [Profile replacement contract](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/postgres-agent-profile-store.mjs#L46-L58)
