# Installation

Burrow runs as a local Node.js application with PostgreSQL and an optional browser interface. Choose a [native installation](#native-installation) or [container deployment](../operations/containers.md).

!!! warning "Grant access deliberately"
    Burrow does not provide a comprehensive sandbox around agent actions. Its tools can use the host permissions and credentials you grant. Start with an unprivileged account, restricted network access, and a test workspace. Read [trust boundaries](../security/trust-boundaries.md) before enabling integrations.

## Requirements

| Component | Native requirement |
|---|---|
| Node.js | Version 24 or newer, with npm; provisioned automatically on supported Linux hosts when needed |
| Download/extraction | `curl`, `tar`, and gzip support |
| Database | PostgreSQL 17 with pgvector, managed locally or external |
| Managed database account | Non-root OS account |
| Persistent Linux service | systemd user manager and permission to enable user lingering |
| Disk | Space for application staging, dependencies, database, workspaces, and a separate backup |

The complete automatic provisioning path is Ubuntu with systemd, run as the non-root account that will own Burrow with sudo access. The installer provisions Node.js 24 with npm when needed and missing PostgreSQL 17 and pgvector packages through PGDG, requiring sudo for package installation. On other hosts, install these prerequisites yourself or use [external PostgreSQL](../operations/deployment.md#external-postgresql). The source does not define a universal minimum RAM/disk requirement; size the host for model integrations, database growth, and tool workloads.

Automatic NodeSource provisioning supports Ubuntu and RHEL-family Linux 9+; `--install-node` remains a compatibility alias for this default behavior. Automatic PostgreSQL/pgvector provisioning is Ubuntu-only, so Node provisioning alone does not make RHEL-family hosts a complete automatic setup path. The repository does not establish a supported native Windows or macOS installer workflow.

## Native installation

Run as the account that will own Burrow:

```sh
curl -fsSLo install-burrow.sh \
  https://raw.githubusercontent.com/NightShaman/Burrow/main/install.sh
sh install-burrow.sh --help
```

Review the downloaded script, then install:

```sh
sh install-burrow.sh
```

The default location is `$HOME/.burrow`. The installer resolves the current public `main` commit and obtains that immutable assembly, stages production dependencies, installs runtime integrations, and activates the application. Existing prebuilt UI assets are reused; an assembled source without them may require a UI build.

A fresh default install creates, enables, and starts a persistent systemd user service. It enables and verifies lingering, using sudo as a fallback when needed, so the service survives logout and reboot. The service starts through Burrow's normal PostgreSQL supervisor; installation succeeds only after HTTP readiness reports the installed version.

Open `http://127.0.0.1:42817`, then follow [initial setup](initial-setup.md). Inspect the running service with:

```sh
"$HOME/.burrow/bin/burrow" service status
"$HOME/.burrow/bin/burrow" service logs -n 100
```

For foreground use, an operator-managed supervisor, or a host without persistent systemd user services, opt out explicitly:

```sh
sh install-burrow.sh --no-service
"$HOME/.burrow/bin/burrow" serve
```

Keep that terminal running. Do not run a foreground process and a user service on the same port. You can opt into service management later with `burrow service install`.

Re-running the installer updates/restarts an existing managed service without re-enabling a disabled service. Existing manual installations remain manual; a reinstall does not silently add a service.

## Installer options

| Option | Effect |
|---|---|
| `--dir PATH` | Choose application and durable-state root |
| `--source-dir PATH` | Use a local assembled checkout instead of downloading |
| `--host HOST` | Set listener; fresh native default is `127.0.0.1` |
| `--port PORT` | Set listener port; default is `42817` |
| `--install-node` | Compatibility alias; Node 24 provisioning is already automatic when needed |
| `--no-service` | Skip automatic service setup for foreground use or an operator-managed supervisor |
| `--no-install-dependencies` | Skip dependency installation/build and automatic service setup; development only |
| `--verbose` | Show timestamped installer/update diagnostics |
| `--help` | Display installer usage |

Example custom location, retaining loopback access:

```sh
sh install-burrow.sh --dir "$HOME/apps/burrow" --host 127.0.0.1 --port 42817
"$HOME/apps/burrow/bin/burrow" service status
```

`--source-dir` requires an assembled tree containing both `backend/` and `ui/`. A Backend-only checkout is not an assembled install source.

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
