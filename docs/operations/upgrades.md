# Upgrades


!!! warning "Earlier technical reference"
    This page is retained from earlier documentation and has not been fully revalidated for the public 2026.10.19 release. Its revision-specific links and examples may describe older or development behavior. Start with the [current operator guide](../guide/installation.md); do not use this page alone to select installation commands, image tags, or security settings.


Upgrade the deployment through its own distribution path: the native launcher for user installs, image replacement for containers. Preserve durable state and the settings encryption key.

## Before changing a deployment

1. Record the current version from health and the installed `SOURCE_VERSIONS`
2. Review the target release and [known limitations](../project/known-limitations.md)
3. Make a consistent [backup](backup-recovery.md) and confirm how to restore it
4. Allow space for new and previous application payloads and dependency staging
5. Plan a maintenance window for active agent work, provider calls, and schema migration

The public **2026.10.19** release includes PostgreSQL migrations through version 60. The inspected development build **2026.10.21.2** adds version 61; do not treat that newer schema as already published. Existing history can require data backfill; allow migration time and keep a restorable pre-upgrade copy. See [storage schema](../reference/storage-schema.md) for the exact ledger.

If startup appears to wait on PostgreSQL, use [long-migration checks](troubleshooting.md#upgrade-waits-on-a-database-migration) to distinguish elapsed time, CPU activity and lock waits before taking action.

Application version and database schema are distinct. A previous app may reject a newer migration ledger; an image/app rollback is not a database rollback.

## Native update

Run as the installation owner:

```sh
"$HOME/.burrow/bin/burrow" update --verbose
```

The launcher enters the installed updater, which resolves the current public `main` SHA, downloads that immutable archive, and hands control to the incoming installer. The installer stages the replacement while the existing service remains active, swaps the app directory, updates the launcher/integrations, then restarts an existing managed user service. It preserves the service enablement state, so a disabled service is not re-enabled. Existing manual installations remain manual; the automatic creation of a persistent service applies to fresh default installs only.

Durable `burrow.env`, `config/`, `workspace/`, `cache/`, `reports/`, and integrations remain under the install root. Installer-owned path variables are reconciled. Existing listener values are preserved unless supplied explicitly:

```sh
"$HOME/.burrow/bin/burrow" update --host 127.0.0.1 --port 42817
```

The normal update command tracks current assembled `main`; it has no release-selection flag. To inspect or install a chosen historical assembly, use a separately obtained checkout and the documented `--source-dir` installer path, after checking database compatibility.

### Current update-channel handling

Current installer/launcher code implements a validated `BURROW_UPDATE_REPOSITORY` override and preserves the saved installation channel when no process override is supplied. This was absent from historical public **2026.10.19**. Do not change a live installation's channel based on development instructions or assume that its updater already implements this behavior.

## Verify activation

```sh
"$HOME/.burrow/bin/burrow" service status
"$HOME/.burrow/bin/burrow" service logs -n 100
curl -fsS http://127.0.0.1:42817/health
cat "$HOME/.burrow/app/SOURCE_VERSIONS"
```

Check the returned version against the installed build, then verify a normal conversation and one required integration. Do not infer completion from a Git push, downloaded files, or an active systemd unit alone.


!!! note "Public readiness verification"
    The installer checks `/api/health` after restarting. Both health paths now run before authentication and report readiness/build identity. If verification fails, inspect the service invocation, listener, logs, and expected version; authentication alone is no longer the source-backed explanation. Health does not validate a complete model or integration workflow.


If no managed user service exists, the installer does not manage your external supervisor. Restart and validate it through the supervisor you own.

## Failure and rollback boundaries

A failure while staging should leave the running application available. A failed rename when activating the staged app restores the prior app directory. Later failures, including restart or health verification, do **not** provide a universal automatic rollback of application, integration, environment, and database changes.

Do not repeatedly update while an earlier attempt is still active. Capture the stage/error, inspect which version is installed and running, and use the backup/recovery plan if compatibility prevents normal startup. Never edit published release artifacts or migration checksums to force a downgrade.

## Containers

Pin the intended image tag, then follow [container upgrade](containers.md#upgrade-and-backup). Keep the same durable volume and matching key. A container replacement uses startup migrations just like native startup; restoring an older image alone may be insufficient.




## Targeted source review

Corrections on this page were checked against public **2026.10.19**; any newer development behavior is labeled separately. This was static source inspection, not a live deployment test. Other retained details remain subject to the earlier-reference warning.

- [install.sh](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/install.sh)
- [backend/src/postgres-application-schema.mjs](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/backend/src/postgres-application-schema.mjs)
