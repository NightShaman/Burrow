# Installation

Burrow runs as a local Node.js application with PostgreSQL and an optional browser interface. Choose a [native installation](#native-installation) or [container deployment](../operations/containers.md).

!!! warning "Grant access deliberately"
    Burrow does not provide a comprehensive sandbox around agent actions. Its tools can use the host permissions and credentials you grant. Start with an unprivileged account, restricted network access, and a test workspace. Read [trust boundaries](../security/trust-boundaries.md) before enabling integrations.

## Requirements

| Component | Native requirement |
|---|---|
| Node.js | Version 24 or newer, with npm |
| Download/extraction | `curl`, `tar`, and gzip support |
| Database | PostgreSQL 17 with pgvector, managed locally or external |
| Managed database account | Non-root OS account |
| Persistent Linux service | systemd user manager and permission to enable user lingering |
| Disk | Space for application staging, dependencies, database, workspaces, and a separate backup |

The installer can provision missing PostgreSQL 17 and pgvector packages on Ubuntu through PGDG, requiring sudo for package installation. On other hosts, install these prerequisites yourself or use [external PostgreSQL](../operations/deployment.md#external-postgresql). The source does not define a universal minimum RAM/disk requirement; size the host for model integrations, database growth, and tool workloads.

`--install-node` supports NodeSource provisioning on Ubuntu and RHEL-family Linux 9+. Assembly revision resolution now uses shell tools rather than Node; the earlier bootstrap-order caveat no longer applies. The repository does not establish a supported native Windows or macOS installer workflow.

## Native installation

Run as the account that will own Burrow:

```sh
node --version
npm --version
curl -fsSLo install-burrow.sh \
  https://raw.githubusercontent.com/NightShaman/Burrow/main/install.sh
sh install-burrow.sh --help
```

Review the downloaded script, then install:

```sh
sh install-burrow.sh
```

The default location is `$HOME/.burrow`. The installer resolves the current public `main` commit and obtains that immutable assembly, stages production dependencies, installs runtime integrations, and activates the application. Existing prebuilt UI assets are reused; an assembled source without them may require a UI build.

Start in the foreground:

```sh
"$HOME/.burrow/bin/burrow" serve
```

Open `http://127.0.0.1:42817`, then follow [initial setup](initial-setup.md). Keep this terminal running, or stop it cleanly before installing the persistent service:

```sh
"$HOME/.burrow/bin/burrow" service install
"$HOME/.burrow/bin/burrow" service status
```

Service installation enables and verifies lingering so the user service can survive logout and reboot. If the host cannot provide that, use `burrow serve` under an operator-managed supervisor; a failed service installation is not proof that the app cannot run.

## Installer options

| Option | Effect |
|---|---|
| `--dir PATH` | Choose application and durable-state root |
| `--source-dir PATH` | Use a local assembled checkout instead of downloading |
| `--headless` | Omit bundled UI assets |
| `--host HOST` | Set listener; fresh native default is `127.0.0.1` |
| `--port PORT` | Set listener port; default is `42817` |
| `--install-node` | Provision Node 24 on supported Linux hosts when needed |
| `--no-install-dependencies` | Skip dependency installation/build; development only |
| `--verbose` | Show timestamped installer/update diagnostics |
| `--help` | Display installer usage |

Example custom location, retaining loopback access:

```sh
sh install-burrow.sh --dir "$HOME/apps/burrow" --host 127.0.0.1 --port 42817
"$HOME/apps/burrow/bin/burrow" serve
```

`--source-dir` requires an assembled tree containing both `backend/` and `ui/`, including for headless installation. A Backend-only checkout is not an assembled install source.

## Installed layout

```text
~/.burrow/
├── app/                 replaceable backend, UI, and installer
├── bin/burrow           self-locating management launcher
├── burrow.env           private environment and settings encryption key
├── config/              runtime configuration material
├── postgres/            managed database, when selected
├── postgres-socket/     private managed database socket
├── workspace/           agent/global workspaces and file-backed artifacts
├── cache/
├── reports/
└── integrations/        runtime-owned CLI integrations
```

The database is authoritative for core settings and conversations. The presence of a workspace directory does not make it a transcript database. See [persistence](../architecture/persistence.md).

## Verify and continue

```sh
curl -fsS http://127.0.0.1:42817/health
"$HOME/.burrow/bin/burrow" service logs -n 100
```

Inspect the JSON `ok` and `version` fields. Both `/health` and `/api/health` are public readiness/build-identity routes in this snapshot. Health does not prove that a model is configured or that a chat has succeeded.

Next: [initial setup](initial-setup.md), [deployment](../operations/deployment.md), [upgrades](../operations/upgrades.md), and [backup and recovery](../operations/backup-recovery.md).

## Source evidence

- [Native installer](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/install.sh)
- [Database supervisor](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/scripts/postgres-supervisor.mjs)
- [Managed lifecycle](https://github.com/NightShaman/Burrow/blob/c15064dd177788afcdda357a5e545510f754a754/backend/src/postgres-lifecycle.mjs)
