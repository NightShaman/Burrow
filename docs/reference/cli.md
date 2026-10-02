# Command-line reference

Burrow has two command layers: the installed shell launcher and the backend Node CLI. Use the installed launcher for a normal deployment; it loads the private environment and supplies the application root.

```sh
"$HOME/.burrow/bin/burrow" --help
```

The raw Node CLI is `backend/bin/burrow.mjs` in the assembly. Most raw commands require `--root DIR`. Do not assume `update` or `service` works when calling that file directly.

## Installed launcher commands

| Command | Effect |
|---|---|
| `serve` | Start database supervisor and HTTP application |
| `update [installer options]` | Download/stage/activate current assembly |
| `service install` | Create/start persistent user service with lingering |
| `service start\|stop\|restart\|status` | Manage user service |
| `service logs [journal arguments]` | Read user-unit logs |
| `service uninstall` | Remove user unit |
| `uninstall [--purge] [--yes]` | Remove application; optionally durable state |
| `install-backup --output FILE [--confirm] [--json]` | Preview/create full-install archive |
| `install-restore --archive FILE [--home DIR] [--replace] [--confirm] [--json]` | Preview/restore into `<home>/.burrow` |

See [installation](../getting-started/installation.md), [upgrades](../operations/upgrades.md), and [backup and recovery](../operations/backup-recovery.md) before mutating a deployment.

## Conversation and inspection

| Command | Key inputs | Behavior |
|---|---|---|
| `ask`, `chat` | `--message TEXT`, optional session/agent options | Advertised conversation entry points; store-wiring gap below |
| `plan` | `--message TEXT`, optional workspace/action hints | Advertised planning surface; store-wiring gap below |
| `trace` | `--run-id ID` or `--latest`, optional `--tool-output` | Summarize trace with PostgreSQL evidence |
| `session-search` | `--session-id`, optional `--query`, `--role`, `--source-id`, `--agent-id` | Search stored session evidence |
| `doctor` | optional `--check-memory` | Advertised diagnostic surface; store-wiring gap below |
| `retention` | optional `--confirm`, `--summary`, `--agent-id` | Preview by default; confirmed cleanup mutates state |

These examples assume the shell already selects the correct database. For a default managed install, put each desired command inside the [managed connection subshell](#managed-reader-connection), replacing its final trace command; the subshell does not configure later commands:

```sh
"$HOME/.burrow/bin/burrow" session-search \
  --agent-id assistant --session-id default --query 'decision' --role any --json
"$HOME/.burrow/bin/burrow" trace --agent-id assistant --latest --tool-output
"$HOME/.burrow/bin/burrow" retention --agent-id assistant --json
```

Model credentials belong in protected connection configuration, not secret-bearing command arguments. Use the working HTTP/UI chat entry point for conversations in this snapshot.

PostgreSQL-backed readers need a running reachable database and settings key. They do not start the database; composing application stores can run the schema migration check. `--agent-id` defaults to `hatchet` in these CLI paths, so use the actual owner explicitly when investigating a different agent.


### Managed reader connection

`session-search`, `trace`, and `retention` compose PostgreSQL stores, but they do not derive the managed socket from lifecycle settings. The installed launcher alone does not fill these connection fields. For the default managed installation, this subshell loads the trusted installer-created environment/key and explicitly selects its private database:

```sh
(
  set -a
  . "$HOME/.burrow/burrow.env"
  set +a
  unset BURROW_POSTGRES_URL DATABASE_URL BURROW_POSTGRES_PASSWORD
  export BURROW_POSTGRES_HOST="$HOME/.burrow/postgres-socket"
  export BURROW_POSTGRES_PORT=5432
  export BURROW_POSTGRES_DATABASE=postgres
  export BURROW_POSTGRES_USER="$(id -un)"
  node "$HOME/.burrow/app/backend/bin/burrow.mjs" trace \
    --root "$HOME/.burrow/app/backend" --agent-id assistant --latest
)
```

Substitute your actual runtime/socket path and agent ID. Keep PostgreSQL running. Replace the final command with the desired reader/retention command; do not use this managed configuration for an external database. The subshell avoids changing the caller's long-lived environment and does not print the key.

### CLI retention policy

CLI retention uses environment/default policy, not the persisted UI/Albdruck policy or its enabled flag. Defaults are 60 days for eligible main-kind sessions, 30 for task sessions, and 7 for subagent sessions; trace age/byte caps require explicit environment settings. Preview without `--summary` to inspect candidate identities before ever adding `--confirm`. See [retention maintenance](../operations/procedures.md#retention-maintenance).

### Legacy store-wiring gap

The CLI's shared model/planning dispatch calls `resolveModelConfig(args)` without a model store. The resolver requires a store and raises `model_settings_store_required`. This affects the advertised `ask`, `chat`, `plan`, `run`, `factory`, and Dream branches before they reach their intended behavior. `doctor` also calls the resolver without store injection. HTTP chat composes/injects application stores separately. These are source-confirmed CLI wiring limitations, not reasons to recreate retired JSON configuration or pass raw provider keys on the command line.

## Execution-oriented commands

`run` advertises `--dry-run` or `--call-model`, but is subject to the store-wiring gap above. Do not treat the advertised dry run as a verified no-write path.

`review-proposal` accepts `--message JSON` or `--proposal-file PATH` and reviews normalized proposed actions without executing them.

`factory` is a legacy execution-oriented surface, currently subject to the same wiring gap. Its implementation has stronger defaults: model calls, proposal execution, mutation, and commits are enabled. It supports `--max-turns`, `--verify-command`, `--commit-message`, `--allow-dirty-worktree`, and `--allow-protected-branch`. Default checks reject dirty worktrees and `main`/`master`; overrides remove those checks. This is not the normal chat-first onboarding path. Use only against an explicitly selected disposable or authorized project.

Options appearing in shared help may apply only to a subset of commands. The parser is not a full per-command schema validator; unsupported combinations should not be treated as a stable API.

## Managed PostgreSQL access

```text
burrow postgres-access create|rotate|revoke|list [--name NAME] [--json]
```

- Managed mode only; server already running under the same OS account
- Name: 1–47 lowercase ASCII letters/digits/underscores, starting with a letter
- Role namespace: `burrow_operator_`
- Create grants public-schema table SELECT plus owner default privileges, with no superuser or write role
- Create/rotate emits a new password once; never send this output to a shared transcript/log
- Rotate/revoke attempts to terminate existing reader sessions; a post-commit warning means the credential change already committed
- Revoke refuses owned objects rather than deleting source data

The private socket gains role-specific SCRAM rules. This does not isolate readers from an OS account that already controls the database owner, and it does not make sensitive tables nonsensitive.

## Advertised Dream CLI commands

`dream-memory` and `dream-cycle` appear in shared help and the accepted command list, but this snapshot has no dedicated dispatch branch for them and also reaches the shared store-wiring gap. Do not use them as a documented way to start a Dream cycle. Use supported UI/API Dream settings and controls described in [Dreams](../concepts/dreams.md).

## Chat slash commands

These are messages handled by the HTTP chat path, separate from shell commands:

| Command | Purpose |
|---|---|
| `/help` | List available commands |
| `/status` | Agent/model/run/context status |
| `/context` | Current reconstructible context |
| `/context full` | Captured provider-visible request context, when available |
| `/new` | Start fresh conversation boundary, archiving prior history |
| `/stop` | Cancel active run in selected session |

`/context full` can reveal private conversation and evidence; review before sharing.

## Source evidence

- [Backend CLI usage and dispatch](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/bin/burrow.mjs)
- [Installed launcher](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/install.sh#L493-L578)
- [Model-store requirement](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/config.mjs#L94-L96)
- [Managed PostgreSQL access](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/managed-postgres-access.mjs)
- [Slash-command dispatch](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/scripts/burrow-ui.mjs#L2830-L2875)
