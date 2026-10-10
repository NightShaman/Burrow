# BURROW

BURROW is an agent runtime with a web interface, model-provider connections, native and MCP tools, durable conversations, task execution, and PostgreSQL-backed application state.

This manual explains the runtime an operator installs and the code a developer extends. It follows the assembled release and its pinned Backend and UI sources; it does not assume that a running installation has already been upgraded.

<div class="grid cards" markdown>

-   **Install and configure**

    ---

    Choose a native installation or container, complete setup, and connect an agent to a model.

    [Installation](getting-started/installation.md) · [Initial setup](getting-started/initial-setup.md)

-   **Understand execution**

    ---

    Follow a chat turn through context preparation, model execution, tools, Minions, and persistence.

    [Architecture](architecture/overview.md) · [Execution flow](architecture/execution-flow.md)

-   **Operate reliably**

    ---

    Upgrade deliberately, protect the database and encryption key, and diagnose failures from evidence.

    [Operations](operations/procedures.md) · [Backup and recovery](operations/backup-recovery.md)

-   **Build on the runtime**

    ---

    Find source ownership, developer workflows, API surfaces, and extension boundaries.

    [Developer setup](development/setup.md) · [API reference](reference/api.md)

</div>

## What do you want to do?

- [Connect a model and send your first message](getting-started/initial-setup.md)
- [Use Chat, follow tool progress, and stop work](concepts/interface.md#chat-and-sessions)
- [Save or correct a memory in Brains](concepts/memory.md)
- [Find an earlier conversation](concepts/conversation-history.md)
- [Start, restart, and inspect Burrow](operations/procedures.md)
- [Fix a setup or connection problem](operations/troubleshooting.md)

## Before first use

1. Read [core concepts](concepts/core-concepts.md) to distinguish agents, sessions, Minions, workers, and tools.
2. Review [authentication](security/authentication.md) before exposing the listener beyond a trusted host.
3. Read [storage and recovery](architecture/persistence.md): PostgreSQL is central, but files and the settings encryption key also matter.
4. Check the [known limitations](project/known-limitations.md) for incomplete commands and packaging differences in this documented snapshot.

!!! warning "A workspace is not a security sandbox"
    Agent workspace roots provide execution context. They do not by themselves confine filesystem access or shell commands. Configure and verify the actual [permission and trust boundaries](security/permissions.md).

## Documentation baseline

The operator guides are updated for assembled build **2026.10.10.4**, commit [`c15064d`](https://github.com/NightShaman/Burrow/tree/c15064dd177788afcdda357a5e545510f754a754). Exact source pins, inspection scope, and validation limits are recorded in [Source and coverage](project/source-map.md). References distinguish current behavior, compatibility paths, source-visible gaps, and unverified deployment behavior.

For precise values, use the [configuration](reference/configuration.md), [environment](reference/environment.md), and [CLI](reference/cli.md) references rather than older examples from unrelated releases.
