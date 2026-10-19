# Install Burrow

This guide follows the public **2026.10.19** release. Choose a native Linux installation or a container, then [create your first agent](first-agent.md).

Burrow starts with authentication set to **None**. Keep the first-run interface on localhost or behind an SSH tunnel. Before opening it to other computers, configure authentication, HTTPS, and network access controls.

## Native Linux installation

The fully automated path is **Ubuntu with systemd**, using the ordinary, non-root account that will own Burrow. Have `curl` available and sudo permission for missing system packages and user-service setup.

The installer needs:

- Node.js **24 or newer** and npm
- PostgreSQL **17** with the **pgvector** extension
- Git and an SSH client for skill repositories
- systemd and `loginctl` for the default persistent service

It installs missing Node.js on Ubuntu or RHEL-family Linux 9+, but automatic PostgreSQL installation is Ubuntu-only. Other hosts need the database prerequisites prepared separately. Managed PostgreSQL refuses to run as root; do not run the whole installer with sudo.

```sh
curl -fsSL https://raw.githubusercontent.com/GoblinKing-Burrow/Burrow/main/install.sh | sh
```

This downloads the current assembled `main`, installs into `~/.burrow`, and enables a systemd user service. The installer enables lingering so the service can survive logout and reboot. It waits for the running server to report the installed build before printing its ready URL. Database initialization and migrations can take time.

Open **http://127.0.0.1:42817**. Check the service and build with:

```sh
~/.burrow/bin/burrow service status
curl -fsS http://127.0.0.1:42817/api/health
```

The health response should contain `"ok": true`, `"runtime": "burrow"`, and a `version`. A healthy server still needs a model connection before it can answer a chat.

### Installing on a remote server

Leave Burrow bound to localhost. From your own computer, open an SSH tunnel, replacing the account and server name:

```sh
ssh -N -L 42817:127.0.0.1:42817 your-user@your-server
```

Keep that terminal open and visit **http://127.0.0.1:42817** on your computer. If that local port is occupied, use `-L 42818:127.0.0.1:42817` and open port 42818 instead.

### Custom location or manual supervision

Download the script when you need options:

```sh
curl -fsSL https://raw.githubusercontent.com/GoblinKing-Burrow/Burrow/main/install.sh -o install-burrow.sh
sh install-burrow.sh --dir "$HOME/burrow"
```

`--dir` must be absolute and contain only letters, digits, `_`, `.`, `/`, and `-`. Commands for this example live at `$HOME/burrow/bin/burrow`.

For a foreground process instead of a new systemd service:

```sh
sh install-burrow.sh --no-service
~/.burrow/bin/burrow serve
```

Keep the process running or provide your own supervisor. `--no-service` changes the fresh-install behavior; it does not remove an existing service. Do not start a second `serve` process beside the existing service.

`--host` and `--port` set durable listener values. Keep `127.0.0.1` for local-only use. `--source-dir /absolute/checkout` installs an assembled checkout without downloading it; it must contain both `backend` and `ui`. The normal installer and `burrow update` follow current `main`, rather than a selected release tag.

### What is stored where?

Under the default `~/.burrow` root:

- `app/`: replaceable application files
- `bin/burrow`: the launcher
- `burrow.env`: durable environment settings and the settings-encryption key
- `postgres/`: the managed PostgreSQL database
- `workspace/`: agent files, skills, tools, and artifacts
- `config/`, `cache/`, `reports/`, `integrations/`: additional runtime state and installed integrations

Keep `burrow.env` private and back it up with the matching database. Updates replace application files while preserving durable state. See [maintenance and recovery](maintenance.md).

### Using an existing PostgreSQL server

This is an operator-managed deployment. Before installation, configure `BURROW_POSTGRES_LIFECYCLE=external` and the intended database connection in the installation root's `burrow.env`. The external database must be PostgreSQL 17 and already have `vector` installed. Burrow checks it and applies its application migrations; it does not create the extension or own the external server's lifecycle. Back up that database separately.

Do not choose a disabled lifecycle to avoid installing PostgreSQL: this release requires PostgreSQL. See the [external database checks](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/postgres-lifecycle.mjs#L117-L172) and [installer database configuration](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/install.sh#L367-L420).

## Container installation

The published configuration uses `ghcr.io/goblinking-burrow/burrow:latest`. The image includes Node.js, PostgreSQL 17, and pgvector, runs as UID/GID 4226, and keeps durable state in `/data`.

For a local-only first run, save this as `compose.yml` in a new directory:

```yaml
services:
  burrow:
    image: ghcr.io/goblinking-burrow/burrow:latest
    pull_policy: always
    init: true
    user: "4226:4226"
    environment:
      HOME: /home/burrow
    ports:
      - "127.0.0.1:42817:42817"
    volumes:
      - burrow-data:/data

volumes:
  burrow-data:
```

```sh
docker compose up -d
docker compose logs --tail=100 burrow
curl -fsS http://127.0.0.1:42817/api/health
```

Then open **http://127.0.0.1:42817**. On a remote Docker host, use the SSH tunnel above. Keep this Compose directory and volume: the volume holds your database, files, and encryption key. `latest` can change, so record the health version and image digest for deployments you need to reproduce.

The repository's own `compose.yml` publishes both **42817** (web interface) and **7443** (Host Gateway controller) on the host's network interfaces. The example here deliberately publishes only the local web interface. Publish the gateway port only when configuring execution nodes, and restrict its network access. Do not use `docker compose down -v` unless you intend to delete the stored data.

## Before enabling network access

Open **Settings → Connections → Authentication** and configure Basic Username/Password, OIDC, or a correctly configured Trusted Proxy. Put remote access behind HTTPS. Authentication preferences can be overridden by environment settings; the page displays the effective mode and warns when an environment override is active.

For the next steps, continue to [your first agent and model](first-agent.md). If startup fails, see [troubleshooting](maintenance.md#troubleshooting).

## Verified source

- [Installer prerequisites, service, and durable paths](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/install.sh)
- [Container image](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/Dockerfile) and [published Compose configuration](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/compose.yml)
- [Authentication defaults](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/src/config.mjs#L171-L209)
- [Public health routes](https://github.com/GoblinKing-Burrow/Burrow/blob/deec39818955db1711161b5310d5822e65fda39a/backend/scripts/burrow-ui.mjs#L3050-L3066)
