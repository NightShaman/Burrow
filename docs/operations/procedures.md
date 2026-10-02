# Common operational procedures

These recipes assume the default native user installation. For containers, use the corresponding [container commands](containers.md). Replace example agent/session IDs with real values and run as the installation owner.

## Start, stop, inspect

```sh
"$HOME/.burrow/bin/burrow" service start
"$HOME/.burrow/bin/burrow" service status
"$HOME/.burrow/bin/burrow" service logs -n 100
```

For a deliberate restart:

```sh
"$HOME/.burrow/bin/burrow" service restart
curl -fsS http://127.0.0.1:42817/health
```

Check active work before restart. Shutdown records interruption evidence, but recovery is not a guarantee that all external actions can safely be replayed.

## Change listener settings

The installer owns the durable native host/port settings. Apply explicit values during installation or update:

```sh
"$HOME/.burrow/bin/burrow" update --host 127.0.0.1 --port 42817
```

This also performs the normal application update. It is not a settings-only operation. For a deployment that must retain its current app revision, review the existing environment and supervisor configuration using the [configuration reference](../reference/configuration.md), then make an operator-controlled settings change and restart.

Do not switch to `0.0.0.0` without reviewing [network exposure](deployment.md#network-exposure).

## Inspect a completed run

For CLI readers on a default managed installation, substitute the desired command **inside** the [explicit private-socket connection subshell](../reference/cli.md#managed-reader-connection). Running that block once does not configure later standalone commands; lifecycle settings alone do not populate their connection environment.

```sh
"$HOME/.burrow/bin/burrow" trace \
  --agent-id assistant --run-id RUN_ID --json
"$HOME/.burrow/bin/burrow" session-search \
  --agent-id assistant --session-id default --query 'release decision' --json
```

Use an explicit run ID for incident investigation. `--latest` is useful for exploration but can select newer work than the incident being investigated. Keep tool-output/trace artifacts private until reviewed.

## Stop a chat

Use the UI stop control or `/stop` in the selected conversation. Verify the active-run state settles, and inspect any executed tools before retrying the request. Closing a tab is not cancellation.

## Retention maintenance

Prefer the Settings preview/run path when you intend to use the persisted UI policy:

1. Review the configured retention categories and periods in Settings
2. Take a recovery backup if cleanup could remove needed material
3. Preview cleanup and inspect individual candidate targets, not only counts
4. Run only the intended cleanup through that same policy surface
5. Check resulting state and logs

### CLI retention is a separate policy

The CLI reads environment/default retention values. It does **not** read the persisted UI/Albdruck policy or its disabled flag. Defaults are 60 days for eligible main-kind sessions, 30 for task sessions, and 7 for subagent sessions; trace age/byte limits are unset unless configured. A disabled UI policy does not make CLI `--confirm` harmless.

With the correct database connection (use the managed subshell above when needed), preview the **full** target list:

```sh
"$HOME/.burrow/bin/burrow" retention --agent-id assistant --json
```

Do not use `--summary` as the only deletion review: it hides individual candidates. Only after inspecting this CLI-specific plan and a recovery backup should an operator deliberately add `--confirm` to the same invocation with unchanged inputs. Avoid adding duplicate cleanup timers alongside the runtime scheduler.

## Add a read-only database operator

For a running **managed** database, `postgres-access` creates dedicated SQL-reader roles. It requires the same OS owner and lifecycle environment as the server. This is privileged credential administration, not a harmless status check:

```sh
"$HOME/.burrow/bin/burrow" postgres-access list
```

With deliberate authorization, `create --name NAME`, `rotate --name NAME`, and `revoke --name NAME` administer those roles. Create/rotate prints the new password once in JSON. Capture it securely, never in shared logs. The role can read sensitive application tables; read-only access is still data access. See [CLI](../reference/cli.md#managed-postgresql-access).

## Remove the application

To remove the app and launcher while retaining durable state:

```sh
"$HOME/.burrow/bin/burrow" uninstall
```

Full removal also destroys the installation's durable state. Back up first, then use `uninstall --purge` only when that destruction is intended. Noninteractive uninstall requires explicit `--yes`. Container volume deletion is a separate destructive operation.

## Source evidence

- [Installed management launcher](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/install.sh#L493-L578)
- [CLI retention and trace dispatch](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/bin/burrow.mjs#L350-L387)
- [Managed operator access](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/managed-postgres-access.mjs)
- [Retention implementation](https://github.com/NightShaman/Burrow/blob/d6490825401405ce719e007fd96a487c5b0cde56/backend/src/retention.mjs)
