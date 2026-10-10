# Backup and recovery

A complete recovery set contains both PostgreSQL state and the associated filesystem state, including the **matching encryption key**. Selective export is useful for portability but is not disaster recovery.

## Choose the right method

| Method | Includes | Important limit |
|---|---|---|
| Native full-install archive | Complete installed tree, application, environment/key, managed PG files, workspaces, integrations | Requires a consistent filesystem state; external DB is not included |
| Container volume backup | Complete `/data` and any other operator-owned mounts/secrets | Does not include the image or an external DB |
| PostgreSQL logical dump | One database's schema and data | Does not include local files, encryption key, or cluster-wide roles |
| Portable API export | Selected configuration categories | Does not replace history/artifact/database backup |

Keep backups outside the live install root and outside public repositories. Use a unique, previously unused output filename. The helper rejects existing output unless `--overwrite` is explicit, builds and validates an archive in staging, and publishes it only after validation. Restrict access: even encrypted database fields depend on a key that may be present in the same recovery set.

## Native managed database: cold full-install backup

The portable backup command copies raw files. It does not stop PostgreSQL or use an online backup protocol. It now refuses an existing `postmaster.pid` and requires `pg_controldata` to report a cleanly shut-down managed cluster, checking before copying and again before publishing the archive. PostgreSQL requires a shutdown for an ordinary filesystem copy to be usable; coordinate all involved directories if you use an alternative snapshot system. See [PostgreSQL 17 filesystem backups](https://www.postgresql.org/docs/17/backup-file.html).

Choose the output path before the maintenance window:

```sh
BACKUP="$HOME/backups/burrow-install-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
```

For the default managed user-service install:

```sh
"$HOME/.burrow/bin/burrow" service stop
"$HOME/.burrow/bin/burrow" service status
```

Confirm the service and its managed database have stopped. A nonzero status for an inactive unit is expected; unexpected stop errors need investigation. If you use a different supervisor, stop it through that supervisor instead.

Preview after shutdown, then create the archive:

```sh
umask 077
"$HOME/.burrow/bin/burrow" install-backup --output "$BACKUP"
"$HOME/.burrow/bin/burrow" install-backup --output "$BACKUP" --confirm
"$HOME/.burrow/bin/burrow" service start
```

Check the backup command's success before treating the archive as valid. If backup fails, investigate the output and deliberately restart the service when safe; do not leave an unplanned outage. Keep a dated copy and restore-test it.

The helper copies only the install-root tree and does not dereference symlinks. Managed PostgreSQL data outside the install root or reached through an external symlink is rejected. External databases, workspaces, artifact locations, and external symlink targets require separate coordinated backup. Restore also rejects absolute/out-of-tree or unresolved symlinks, so inspect such installations before assuming the tree archive is usable. Inventory your effective paths first.

The archive includes `burrow.env`; losing its `BURROW_SETTINGS_KEY` while retaining the encrypted database can make stored credentials unusable. Do not regenerate that key during recovery.

## Restore a native full-install archive

For a straightforward managed-cluster restore, use an isolated target host with the **same OS username and target-home UID** as the original database owner, plus compatible OS/architecture, Node, PostgreSQL 17, and pgvector prerequisites. Raw database files are not a cross-major or cross-platform migration format. Stop any target runtime first. The restore destination is **`<home>/.burrow`**, regardless of the original custom install directory.

Use a Burrow launcher from a compatible available installation:

```sh
/path/to/available/bin/burrow install-restore \
  --archive /safe/backups/burrow-install.tar.gz \
  --home /home/ORIGINAL_OS_USER
```

Review the preview's environment inventory. For every entry marked `requiresMapping`, prepare a private JSON mapping file whose keys are the listed environment names and whose string values identify the intended target paths/database settings. Repeat the launcher command with `--mapping-file /safe/restore-mapping.json --confirm`. Do not copy production destinations into a rehearsal mapping without reviewing them. Use the main `burrow` launcher: the standalone helper parser does not accept `--mapping-file`.

Existing nonempty destinations require `--replace --confirm`. The restore is prepared and validated in staging before moving the previous tree and activating the replacement; the previous tree is restored if activation fails. Successful replacement removes the old tree during cleanup. Rehearse into an empty isolated home before replacing valuable state.

Restore preserves file modes, rebases installer-owned paths, assigns the target-home owner's UID/GID, and reinstalls runtime integrations with npm. Filesystem chown does not rename PostgreSQL roles: startup connects as the current OS username. Managed physical restore now rejects a different source owner name or target UID, rather than attempting that migration. Use a separately planned logical database/role migration for another owner. It needs network access and does not install missing host prerequisites. It does not recreate the systemd service.

Before the first start, inspect retained absolute paths. Restore rebases only runtime root, workspace root, cache root, and the Claude executable path. Explicit PostgreSQL data/socket/log paths, PostgreSQL binary locations, external database URLs, and other absolute overrides must be acknowledged through the mapping file. Missing required mappings fail before activation. Verify the resulting environment before starting; a restored configuration must not accidentally reuse the original cluster.

As the target account, after checking paths and key:

```sh
"$HOME/.burrow/bin/burrow" service install
"$HOME/.burrow/bin/burrow" service status
```

Avoid starting a restored copy against the production external database during a rehearsal. Review provider credentials and disable unwanted background work before allowing a duplicate instance to operate.

## Logical and external-database backups

For managed PostgreSQL, a database-only dump can use the owner's private socket while the database is running. With default paths and a PostgreSQL 17 client:

```sh
umask 077
mkdir -p "$HOME/backups"
DUMP="$HOME/backups/burrow-database-$(date -u +%Y%m%dT%H%M%SZ).dump"
PGHOST="$HOME/.burrow/postgres-socket" \
PGPORT=5432 PGDATABASE=postgres PGUSER="$(id -un)" \
pg_dump --format=custom --file="$DUMP"
```

Use the actual configured socket if overridden. A logical dump is consistent for the database, but coordinating files and application writes remains your responsibility. External deployments should use their database owner's approved credentials, verified TLS, backup retention, and restore process. `pg_dump` covers one database; cluster-wide roles need separate consideration. [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)

Restore trusted custom-format archives with `pg_restore` into a deliberately selected isolated database, using the database owner's procedure. Do not use destructive restore flags against a live destination as a trial. [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)

The bundled `scripts/runtime-backup.mjs` is narrower than a full install backup: it dumps a database and selected per-agent `skills`, `tools`, and `artifacts`. It now derives its PostgreSQL destination from authoritative runtime configuration and clears conflicting ambient libpq variables. Its omitted key/config/global workspace still mean it must not be treated as a complete recovery procedure.

## Containers

Stop Burrow cleanly and use your container/volume backup tooling to capture all of `/data`, plus any separately configured key or artifact locations. Record the image tag/digest and Compose/environment configuration. Keep an external DB backup separately when used. Restore permissions for the configured numeric UID/GID and start only after the complete matching recovery set is in place.

## Portable exports

The UI/API export catalog supports selected agents/profiles, settings, model connections, MCP connections, UI authentication, and task-board records. Secret-bearing exports require a password. MCP environment-variable plaintext is not included.

These exports do not capture complete conversations, original archives, Brain knowledge, Dream diaries, traces, or filesystem attachments/generated artifacts. A canonical session transcript can be exported separately through `/api/sessions/{sessionId}/export`. See [HTTP API](../reference/api.md).

## Recovery acceptance

- Health reports the intended version/build identity; inspect authenticated runtime status separately for runtime paths
- Matching settings decrypt and the expected agents/models appear
- Known conversation history and one attachment/artifact are readable
- Required MCP connections and per-agent grants still work
- Background schedules and operator timezone are correct
- A low-risk model turn completes without duplicate external actions

## Source evidence

- [Portable backup and restore implementation](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/portable-install-backup.mjs)
- [Database-only/selected-files backup](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/runtime-backup.mjs)
- [Export catalog and encryption](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/export-service.mjs)
- [Managed connection selection](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-startup.mjs)

- [Cold-backup checks and restore inventory](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/portable-backup-policy.mjs)
- [Launcher restore mapping dispatch](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/bin/burrow.mjs#L326-L332)
