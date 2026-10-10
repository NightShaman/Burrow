# Source and coverage

This manual is grounded in the assembled BURROW repository and the exact Backend and UI revisions it records. Source inspection is evidence of implementation; it is not a claim that a particular deployed installation was tested.

## Documented baseline

| Component | Revision |
|---|---|
| Published assembled release | `2026.10.10.4` |
| Public BURROW commit | `c15064dd177788afcdda357a5e545510f754a754` |
| Backend source pin | `2bf4844c0834e67e0993049131a8c86d5baad024` |
| UI source pin | `86dee9ec34bdec9f415e1d7a924cb3cc990bab60` |
| Node Goblin source pin (provenance only) | `53ad311dfa5a41839d219c94a574f07b0a8b036f` |

These pins come from [`SOURCE_VERSIONS`](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/SOURCE_VERSIONS). The [release](https://github.com/NightShaman/Burrow/releases/tag/v2026.10.10.4) was published on 10 October 2026 at 03:39 UTC. This is a fixed documentation baseline, not a promise that a local installation or moving `main` is the same version.

## Inspection scope and limits

The October 10 refresh checks operator-facing changes against the assembled source: setup, model connections and selection, provider cache behavior, Chat activity and steering, Brains and optional embeddings, explicit conversation recall, task execution, maintenance and the older known-limitations list. Storage coverage includes the migration manifest through version 49. Steps name current UI controls and separate an accepted action from its observed result.

The initial manual was based on the October 2 `.6`/`.7` audit. Historical immutable source links remain where that background has not been independently re-audited in full; they are evidence for their cited revision, not proof that every line is unchanged. The refresh is not an exhaustive audit of all intervening runtime changes. The downloadable OpenAPI artifact is explicitly historical; use the current source-backed endpoint pages for newly added or retired routes.

No production installation, paid model call, database migration, destructive cleanup, OAuth login, or restore was executed for this documentation refresh. Static source review and documentation checks do not certify runtime behavior or deployment security. Node Goblin deployment/integration instructions remain outside this manual's scope.

## Documentation ownership

The public assembly preserves root `docs/`, `mkdocs.yml`, documentation dependencies, `scripts/docs/`, and the documentation workflow. These are the correct source for this site. Assembly replaces `backend/`, `ui/`, and the root README; change the upstream Backend deployment README for any permanent root README edit. See [documentation development](../development/documentation.md) and [assembly workflow](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/.github/workflows/assemble.yml).

## Evidence precedence

When artifacts disagree, this manual follows the executable code and configuration at the pinned revision, with schemas, scripts, tests, comments, and existing docs used as supporting evidence. Disagreement is recorded instead of resolved by inventing behavior.

Examples include inactive JSON configuration loading, retired Dream CLI commands, missing packaged API schema, historical runbooks, and generated API types that lag server behavior. See [known limitations](known-limitations.md).

## Coverage map

| Question | Documentation |
|---|---|
| What is BURROW and how do its parts relate? | [Core concepts](../concepts/core-concepts.md), [architecture](../architecture/overview.md) |
| What happens during a request? | [Runtime](../architecture/runtime.md), [execution flow](../architecture/execution-flow.md) |
| How do agents, Minions, tasks, and tools operate? | [Agents and Minions](../concepts/agents-minions.md), [workers](../concepts/workers-tasks.md), [tools](../concepts/tools.md), [MCP](../concepts/mcp.md) |
| What persists and what enters context? | [Persistence](../architecture/persistence.md), [memory](../concepts/memory.md), [Dreams](../concepts/dreams.md), [history](../concepts/conversation-history.md) |
| Where are the security boundaries? | [Authentication](../security/authentication.md), [permissions](../security/permissions.md), [trust boundaries](../security/trust-boundaries.md) |
| How is the system installed and configured? | [Installation](../getting-started/installation.md), [setup](../getting-started/initial-setup.md), [configuration](../reference/configuration.md), [environment](../reference/environment.md) |
| What commands and endpoints exist? | [CLI](../reference/cli.md), [API](../reference/api.md), [schema](../reference/storage-schema.md) |
| How is it operated and recovered? | [Deployment](../operations/deployment.md), [containers](../operations/containers.md), [upgrades](../operations/upgrades.md), [recovery](../operations/backup-recovery.md), [procedures](../operations/procedures.md) |
| How are problems diagnosed? | [Observability](../operations/observability.md), [troubleshooting](../operations/troubleshooting.md) |
| How is it developed and released? | [Development](../development/setup.md), [extensions](../development/extensions.md), [releases](../development/releases.md) |

## Validation boundaries

Documentation validation covers the strict static build, internal links/anchors/assets, and actual browser rendering of Mermaid diagrams. See the [reproducible commands](../development/documentation.md#required-checks).

Application source inspection and focused tests are not a production acceptance test. No live runtime, real provider, real database, authentication account, or operator workspace is required for documentation builds. Database migrations, remote execution, recovery, and deployment must be validated in the target environment before an operator relies on them.
