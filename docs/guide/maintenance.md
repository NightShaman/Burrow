# Maintenance and recovery

Keep a restorable backup before updating or changing database configuration. The examples below assume a native install at `~/.burrow`; use your actual installation path if different.

## Check the running installation

```sh
~/.burrow/bin/burrow service status
~/.burrow/bin/burrow service logs -n 100
curl -fsS http://127.0.0.1:42817/api/health
```

Compare the health response's `version` with `~/.burrow/app/SOURCE_VERSIONS`. The health route reports server/build readiness without requiring login. It does not test model credentials or prove that an agent can complete a task. After a change, also send a short chat and test any integration you depend on.

For containers, use `docker compose ps` and `docker compose logs --tail=100 burrow`, then check the same health URL through the port you published.

## Update

### Native installation

After taking a backup:

```sh
~/.burrow/bin/burrow update
```

For timestamped installer diagnostics:

```sh
~/.burrow/bin/burrow update --verbose
```

The updater downloads the current assembled `main`, stages dependencies and application files, then activates them. An active, matching systemd user service is restarted and checked for the new build. A stopped service stays stopped; an installation without a service stays manually managed. Restart a manually supervised process yourself after the update.

Wait for the command to finish. Startup checks allow time for database initialization and migrations. Do not run a second updater while the first is active. The `.install-lock` protects the installation; an apparent stale lock requires investigation, not automatic deletion.

Updates preserve durable state and operator settings, while reconciling installer-owned paths. A successful download or active service alone is insufficient: verify the health version and a real chat. Do not assume copying an old `app/` back will undo database migrations.

### Container installation

Back up the persistent volume and any external database using your deployment's recovery procedure, then run from the same Compose directory:

```sh
docker compose pull
docker compose up -d
docker compose logs --tail=100 burrow
curl -fsS http://127.0.0.1:42817/api/health
```

Keep the existing data volume. `latest` is mutable; record the image digest and running version if you need reproducibility. An image rollback is not a database rollback. Do not use `down -v` for an upgrade.

## Make a native installation backup

`install-backup` copies the installation tree, including application files, the encryption key, and an in-root managed database. It is a **cold backup**: stop Burrow cleanly first and leave it stopped until the archive is complete. For a foreground process, use its normal shutdown rather than killing it abruptly.

```sh
mkdir -p "$HOME/burrow-backups"
chmod 700 "$HOME/burrow-backups"
~/.burrow/bin/burrow service stop

# Preview. No archive is created without --confirm.
~/.burrow/bin/burrow install-backup \
  --output "$HOME/burrow-backups/burrow-before-update.tar.gz"

# Create the archive after reviewing the preview.
~/.burrow/bin/burrow install-backup \
  --output "$HOME/burrow-backups/burrow-before-update.tar.gz" --confirm

~/.burrow/bin/burrow service start
```

Use a new filename for each backup. The archive must be outside the installation root. Check that backup creation succeeded before relying on it, and check health after restarting.

Important limits:

- A managed database must be inside the installation root and cleanly shut down. The command refuses a `postmaster.pid` file or a cluster whose control data does not report a clean shutdown. It does not stop the database for you.
- External PostgreSQL databases, external file paths, and external symlink targets are excluded. Arrange separate database and file backups for those deployments.
- The archive contains secrets, including the settings-encryption key. File permissions are restricted, but the archive is not encrypted by this command. Store and transfer it securely.
- This command expects the native `app/`, `bin/`, and `burrow.env` layout. It is not a Docker-volume backup command.

## Restore a native installation

Restore is an operator recovery procedure. Test your backup before an emergency. It restores to **`<home>/.burrow`**, not an arbitrary `--dir` target, and does not automatically start a service.

For a managed physical database, the source OS username and UID must match the restoring account/home owner. Prepare compatible PostgreSQL 17 binaries and pgvector, Node.js, and npm on the target. Network access may be needed to reinstall the pinned runtime integrations. Migration to a different OS owner needs a separate logical PostgreSQL migration plan.

### Inspect before replacing anything

With a working Burrow launcher available, preview the archive against an empty review directory owned by the restoring account:

```sh
mkdir -p "$HOME/burrow-restore-review"
~/.burrow/bin/burrow install-restore \
  --archive "$HOME/burrow-backups/burrow-before-update.tar.gz" \
  --home "$HOME/burrow-restore-review" --json
```

This validates the archive and prints an environment inventory without restoring it. An ordinary preview refuses a nonempty destination. Inspect every inventory entry marked `requiresMapping`: retained absolute paths and database settings need an explicit decision in a JSON mapping file.

For an otherwise unmodified native Ubuntu installation, a mapping may look like this:

```json
{
  "BURROW_POSTGRES_LIFECYCLE": "managed",
  "BURROW_POSTGRES_INITDB": "/usr/lib/postgresql/17/bin/initdb",
  "BURROW_POSTGRES_PG_CTL": "/usr/lib/postgresql/17/bin/pg_ctl",
  "BURROW_POSTGRES_BIN": "/usr/lib/postgresql/17/bin/postgres"
}
```

Save it as `$HOME/burrow-restore-map.json` with private permissions. Add every additional mapping required by your archive and verify each target path. Installer-owned runtime, workspace, cache, and Claude executable paths are rebased automatically. A physical managed archive cannot switch to external lifecycle during this restore.

### Apply a replacement

Only after backing up the current destination and stopping its runtime, this example replaces the installation at `$HOME/.burrow`:

```sh
~/.burrow/bin/burrow service stop
~/.burrow/bin/burrow install-restore \
  --archive "$HOME/burrow-backups/burrow-before-update.tar.gz" \
  --home "$HOME" \
  --mapping-file "$HOME/burrow-restore-map.json" \
  --replace --confirm

~/.burrow/bin/burrow service install
curl -fsS http://127.0.0.1:42817/api/health
```

`--replace --confirm` replaces an existing installation. Omit `--replace` for an empty destination. Restore validates archive structure and checksums before activation, but a successful restore still needs a running-build check, a chat test, and checks of your important files and integrations. If you use your own supervisor, restart through that supervisor instead of installing the systemd service.

## Export selected settings and agents

Use **Settings → General → Export** to move selected portable records between installations. It is useful for configuration transfer, but does not include chats, workspace files, historical runs, or mod-owned state.

Select the categories you need and their dependencies. Categories containing secrets require an export password of at least 12 characters. On import, review the preview and conflict policy. Imports can apply partially if a dependency fails, and enabled schedules can remain enabled and run after import. Keep a separate full recovery backup.

## Troubleshooting

### The browser cannot connect

Check service/container logs and the configured listener. Native defaults are `127.0.0.1:42817`; a remote browser needs an SSH tunnel or a properly secured network deployment. `127.0.0.1` in your browser always refers to the computer running that browser.

If startup is still initializing or migrating PostgreSQL, follow logs before restarting repeatedly. If the health version is old after an update, check which process owns the port and whether the intended service restarted.

### PostgreSQL will not start

Check the log's specific error: missing version-17 binaries, missing pgvector, wrong owner, an incompatible database major, or an already running cluster need different repairs. Inspect `~/.burrow/postgres.log` for a default managed install. Do not delete `postgres/`, change database version files, or remove PID files simply to bypass a startup or backup refusal.

For external mode, verify the intended database connection and installed `vector` extension. Burrow never creates that extension in external mode.

### No model appears, or chat fails

Go to **Settings → Connections → Model providers**, then use the **Models** form. Confirm that at least one model is selected and saved, then select it in the chat toolbar. Discovery failure can be handled with an exact manual model ID, but the provider must actually support it. Check authentication, endpoint reachability from the Burrow host/container, and the provider's error message. See [models and connections](models.md).

### Login settings appear unchanged

The Authentication page shows the effective mode. An environment override takes precedence over a saved UI preference. Review the matching `BURROW_UI_AUTH_*` settings without sharing their secret values. Do not disable authentication while leaving a remotely reachable instance exposed.

### A container reports a settings-key mismatch

Restore the matching persisted key and database together. The entrypoint refuses an explicitly supplied `BURROW_SETTINGS_KEY` that differs from the saved key. Generating a replacement key does not decrypt existing credentials.

### What to include in a support report

Include the health version/build identity, native or container deployment, the action that failed, and relevant redacted log lines. Remove API keys, OAuth callbacks, passwords, database URLs containing credentials, and private chat/file contents. Keep an untouched private copy of the logs if needed for your own investigation.

## Uninstall

For native installations:

```sh
~/.burrow/bin/burrow uninstall
```

This removes application files and the launcher while preserving durable state. `--purge` also deletes the installation root and its stored data; take a verified backup first. Noninteractive uninstall requires `--yes`. Removing only the service is a separate command: `~/.burrow/bin/burrow service uninstall`.

## Verified source

- [Updater and service management](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/install.sh#L212-L325) and [activation](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/install.sh#L646-L693)
- [Cold-backup policy and restore inventory](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/scripts/portable-backup-policy.mjs#L14-L32)
- [Portable backup and restore implementation](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/scripts/portable-install-backup.mjs) and [CLI mapping-file support](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/bin/burrow.mjs#L318-L331)
- [Export/import scope and warnings](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/ui/src/features/settings/ExportSettings.tsx#L108-L131)
- [Container encryption-key checks](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/docker-entrypoint.sh#L4-L31)
