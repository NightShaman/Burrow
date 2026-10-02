# Source and coverage

This manual is grounded in the assembled BURROW repository and the exact Backend and UI revisions it records. Source inspection is evidence of implementation; it is not a claim that a particular deployed installation was tested.

## Documented baseline

| Component | Revision |
|---|---|
| Assembled release | `2026.10.02.7` |
| Public BURROW commit | `2d979fecca8434fe02a6ed2e8225c46eb4690098` |
| Backend source pin | `5dcfa0b495441f9f12c733521b8aa431b14f50f8` |
| UI source pin | `b0aff4c0191ece14730bc3d7fd92018e6e126368` |

These pins come from [`SOURCE_VERSIONS`](https://github.com/NightShaman/Burrow/blob/2d979fecca8434fe02a6ed2e8225c46eb4690098/SOURCE_VERSIONS). The public repository is a generated deployment assembly, not a Git submodule collection. Read [repository structure](../development/repository.md) and [release flow](../development/releases.md) before changing generated files.

## Inspection scope

Before writing this manual, all **475 tracked paths** in the initial .6 snapshot were inspected or classified:

| Area | Paths | Inspection |
|---|---:|---|
| Runtime, model adapters, tools, context, workers | 122 | Full source reads |
| Persistence, memory, retention, conversations | 68 | Full source reads |
| UI, interfaces, security, MCP/mod boundaries | 236 | Source/config/test/style reads; binary and generated asset inventory |
| Installation, distribution, CLI, server routes, scripts | 49 | Source/config/document reads; lockfile and binary classification; excluded-mod bootstrap inventory |

Images, minified bundles, and dependency lockfiles were identified as generated or binary artifacts rather than misrepresented as hand-authored source. The excluded Node Goblin mod was not documented. The in-repository core execution-target and extension interfaces remain covered where needed to explain BURROW itself.

Supporting Backend/UI snapshots were materialized at the recorded pins and checked against Git blob identities. All upstream files absent from, or differing from, the assembly were inventoried and classified; relevant documentation, schemas, scripts, and tests were inspected to corroborate public implementation. This does not claim exhaustive execution or line-by-line review of every upstream test assertion.

### Release delta and freeze

A final repository comparison found .7 while the documentation was being written. Its 25 changed paths, including five new persistence modules, received a further source review; the current public snapshot contains **480 tracked paths**. The documentation incorporates the native PostgreSQL state stores and migration ledger through version 26 from that update.

This pass intentionally freezes at .7 while upstream development continues. Source links retain the original .6 commit for unchanged implementation and use .7 for changed/new behavior. They are immutable evidence, not links that silently follow `main`. Later releases require a new source-difference review before their behavior is claimed here.

The initially materialized supporting Backend/UI trees correspond to .6's exact pins. The .7 delta was reviewed from the public assembled implementation; the UI source pin is unchanged. Upstream-only test/schema artifacts remain labeled with their actual source revision rather than being represented as newly regenerated.

## Evidence precedence

When artifacts disagree, this manual follows the executable code and configuration at the pinned revision, with schemas, scripts, tests, comments, and existing docs used as supporting evidence. Disagreement is recorded instead of resolved by inventing behavior.

Examples include inactive JSON configuration loading, incomplete Dream CLI dispatch, missing packaged API schema, historical runbooks, and generated API types that lag server behavior. See [known limitations](known-limitations.md).

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
