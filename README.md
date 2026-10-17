# Burrow

> A chat-first local runtime for people who want capable agents without turning their workbench into a dashboard cult.

Burrow is a self-hosted AI agent application with a web chat interface, model-provider connections, tools, and persistent conversations.

Burrow keeps conversation first. Tools, traces, receipts, tasks, and debug data stay behind the curtain unless they are useful to inspect.

<p align="center">
  <img src="docs/assets/hero.png" alt="Burrow chat-first local agent runtime" width="720">
</p>

[Get started](#get-started) · [Documentation](docs/index.md) · [Troubleshooting](docs/operations/troubleshooting.md)

> [!WARNING]
> **Burrow is not safe by default and does not provide comprehensive guardrails around agent actions.**
>
> Agents can use every tool and integration you grant them, including access to files, credentials, remote systems, and external services. Burrow assumes the operator understands and accepts that blast radius. Use least-privilege credentials, isolated test targets, and only the integrations you deliberately intend to expose.

## Get started

Choose a native installation or Docker. Both use the same web interface and [first-run setup](#first-conversation).

### Native installation

The complete automatic setup path is **Ubuntu with systemd**, running as a **non-root user with sudo access**.

Before installing:

- Have `curl`, `tar`, and gzip support available.
- The installer provisions Node.js 24 with npm when needed, plus missing PostgreSQL 17 and pgvector packages for the default managed database.
- Automatic Node provisioning also supports RHEL-family Linux 9+, but automatic PostgreSQL/pgvector provisioning is Ubuntu-only. Other hosts need the database prerequisites installed separately or an external PostgreSQL 17 server configured in `burrow.env`.
- Persistent service setup requires systemd user services and permission to enable lingering, which keeps the service running after logout and reboot. Use `--no-service` if you will run Burrow in the foreground or with your own supervisor.

Burrow's safety boundary is the access you grant it, not an internal command sandbox. Review the warning above before installing.

Install into `~/.burrow`:

```sh
curl -fsSL https://raw.githubusercontent.com/GoblinKing-Burrow/Burrow/main/install.sh | sh
```

A fresh default install creates and starts a persistent user service, then verifies HTTP readiness and the installed version. Burrow runs as your user; it does not require `/opt` or Docker.

To review the script first or choose another install location:

```sh
curl -fsSLO https://raw.githubusercontent.com/GoblinKing-Burrow/Burrow/main/install.sh
sh install.sh --help
sh install.sh --dir "$HOME/my-burrow"
```

The commands below assume the default `~/.burrow` location. Substitute your chosen path if you installed elsewhere.

For a manual installation, pass `--no-service` to the downloaded installer, then run `~/.burrow/bin/burrow serve` and keep the terminal open. Do not run a foreground process alongside the service on the same port.

Open **http://127.0.0.1:42817** in a browser on the Burrow host, then continue to [First conversation](#first-conversation). For access from another machine, review [authentication](docs/security/authentication.md) and [network exposure](docs/operations/deployment.md#network-exposure) before changing the listener.

See the [installation guide](docs/getting-started/installation.md) for all installer options, the installed directory layout, and database requirements.

### Docker

The published image stores durable runtime state in `/data` and runs as UID/GID `4226:4226` by default.

Create `compose.yml`:

```yaml
services:
  burrow:
    image: ghcr.io/nightshaman/burrow:latest
    pull_policy: always
    init: true
    user: "4226:4226"
    environment:
      HOME: /home/burrow
    restart: unless-stopped
    ports:
      - "42817:42817"
      - "7443:7443"
    volumes:
      - burrow-data:/data

volumes:
  burrow-data:
```

Then start it:

```sh
docker compose up -d
```

Open `http://<docker-host>:42817`, then follow [First conversation](#first-conversation). These port mappings are reachable through the Docker host; restrict them with the host firewall, network policy, or a trusted reverse proxy. TCP `7443` is used by approved Node Goblin execution nodes.

The persistent volume must be writable by the configured numeric identity. Migrate existing Burrow-owned data deliberately rather than recursively changing unrelated container or service data.

To build from source for development instead, clone this repository and use its root `Dockerfile`.

## First conversation

1. Complete the first-run dialog: start fresh or import a trusted export, name yourself and your first agent, and give the agent its identity.
2. Connect a model provider and select a model. You can skip model selection during setup, but model-backed chat needs a configured model.
3. Open **Chat**, select your agent, and choose its **Provider** and **Model**.
4. Send a short, low-risk question and confirm that a complete answer arrives.

The [initial setup guide](docs/getting-started/initial-setup.md) walks through provider connections, saving and selecting models, and operating preferences. The [interface guide](docs/concepts/interface.md) explains Chat, Tasks, Archive, Brains, Forge, and Settings.

## Manage and update

For a native installation, check status and recent logs:

```sh
~/.burrow/bin/burrow service status
~/.burrow/bin/burrow service logs -n 100
```

Update in place:

```sh
~/.burrow/bin/burrow update
```

Updates replace the installed application while preserving your configuration, workspace, and other persistent data. Existing managed services are updated/restarted without re-enabling a disabled service; existing manual installations remain manual. Back up before upgrading and read the [upgrade guide](docs/operations/upgrades.md) for verification and recovery limits.

For other operations:

- [Service commands](docs/reference/cli.md#installed-launcher-commands): start, stop, restart, install, or remove the user service
- [Installation guide](docs/getting-started/installation.md#native-installation): opt into a service after a manual installation
- [Listener settings](docs/operations/procedures.md#change-listener-settings): configure the host and port
- [Container updates and backups](docs/operations/containers.md#upgrade-and-backup): manage Docker installations

## Optional mods

Mods are optional projects maintained separately from Burrow. Their repositories contain their installation, configuration, and update instructions.

- **[Node Goblin](https://github.com/GoblinKing-Burrow/Node-Goblin)** — run approved Burrow tools on remote machines.

## Help and documentation

- [Full manual](docs/index.md)
- [Troubleshooting](docs/operations/troubleshooting.md)
- [Backup and recovery](docs/operations/backup-recovery.md)
- [Known limitations](docs/project/known-limitations.md)
- [Developer setup](docs/development/setup.md)

## Uninstall

For a native installation, remove the application while preserving persistent data:

```sh
~/.burrow/bin/burrow uninstall
```

**To delete the entire Burrow home, including configuration, workspace, sessions, and other persistent data**, back up anything you need first, then use:

```sh
~/.burrow/bin/burrow uninstall --purge
```

Non-interactive uninstall also requires `--yes`. See [removal details](docs/operations/procedures.md#remove-the-application). Container volume deletion is a separate destructive operation.

## Project and feedback

Burrow is a public personal project built around the maintainer's own needs and direction. Issues and thoughtful feedback are welcome and will be read, but opening an issue does not create an obligation to implement it. Changes that do not fit the project's vision may be declined or left unaddressed.
