# Burrow

> [!WARNING]
> Burrow does not provide guardrails for every tool action or external integration. Run it only where you understand the credentials, systems, and data it can reach—and the blast radius of an agent acting with that access. Start with least privilege, isolated test targets, and deliberate integration grants.

<p align="center">
  <img src="burrow-logo.png" alt="Burrow" width="480">
</p>

> A chat-first local runtime for people who want capable agents without turning their workbench into a dashboard cult.

Burrow keeps conversation first. Tools, traces, receipts, tasks, and debug data stay behind the curtain unless they are useful to inspect.

## Project scope

Burrow is a public personal project, built around the maintainer's own needs and direction. Issues and thoughtful feedback are welcome and will be read, but opening an issue does not create an obligation to implement it. Changes that do not fit the project's vision may be declined or left unaddressed.

Burrow is assembled from two human-edited source repositories:

- **[Burrow-Backend](https://github.com/NightShaman/Burrow-Backend)** → `backend/`
- **[Burrow-UI](https://github.com/NightShaman/Burrow-UI)** → `ui/`

`backend/` and `ui/` are tracked snapshots, not submodules and not primary development locations. Each assembly records its exact source commits in `SOURCE_VERSIONS`.

## Install

Burrow installs into one self-contained user home, `~/.burrow` by default:

```sh
curl -fsSL https://raw.githubusercontent.com/NightShaman/Burrow/main/install.sh | sh
```

To install elsewhere, download the script first and pass `--dir`:

```sh
curl -fsSLO https://raw.githubusercontent.com/NightShaman/Burrow/main/install.sh
sh install.sh --dir "$HOME/my-burrow"
```

The installer downloads the assembled `main` revision, installs dependencies, builds the bundled UI, and creates:

```text
~/.burrow/
├── app/          # replaceable installed application
├── bin/burrow    # launcher and management command
├── burrow.env    # durable runtime environment
├── config/       # settings database and configuration
├── workspace/    # workspace and project material
├── cache/
├── reports/
└── integrations/
```

Node.js, npm, `curl`, and `tar` must be available. The installer does not require `/opt`, root access, or Docker.

## Install a Node Goblin

A Node Goblin is the lightweight execution service for a remote Burrow controller. Install the latest calendar-versioned release from the main Burrow repository:

```sh
curl -fsSL https://raw.githubusercontent.com/NightShaman/Burrow/main/install-node-goblin.sh | sudo sh
sudo node-goblin configure
sudo node-goblin connect
```

The installer downloads the release tarball and checksum from `NightShaman/Node-Goblin`, verifies it, and installs the systemd service. Configuration asks only for the controller address and stable node ID. On first connection, compare the pairing code printed by the Node Goblin with Burrow's pending pairing and approve it in Settings.

Pin a calendar release or configure non-interactively with non-secret values:

```sh
curl -fsSL https://raw.githubusercontent.com/NightShaman/Burrow/main/install-node-goblin.sh \
  | sudo sh -s -- --version 2026.09.01 --controller gkl42.example:7443 --node-id hatchet
```

The installer adopts a conventional existing `burrow` account or creates a narrow service account with UID/GID `4226:4226`. It does not grant sudo, alter supplementary groups, or manufacture host permissions.

### Options

```text
--dir PATH                    install root; defaults to ~/.burrow
--headless                    install runtime without bundled UI assets
--host HOST                   listener host; defaults to 127.0.0.1
--port PORT                   listener port; defaults to 42817
--no-install-dependencies     skip npm install/build; development use only
--source-dir PATH             install from an assembled local Burrow checkout
--help                        show all options
```

## Run and update

Start Burrow:

```sh
~/.burrow/bin/burrow serve
```

The default listener is `127.0.0.1:42817`. Configure it explicitly during unattended installation, for example `sh install.sh --host 0.0.0.0 --port 42817`. Re-running the installer without listener flags preserves the existing values; supplying either flag updates that value and a managed service is restarted after activation.

Update in place:

```sh
~/.burrow/bin/burrow update
```

An update downloads the current assembled Burrow revision and atomically replaces only `~/.burrow/app`. It preserves `burrow.env`, `config/`, `workspace/`, `cache/`, `reports/`, and `integrations/`.

### Run as a user service

On Linux hosts with systemd user services, install and start a persistent service:

```sh
~/.burrow/bin/burrow service install
```

It creates `~/.config/systemd/user/burrow.service`, enables it, and starts it. Management commands are:

```sh
~/.burrow/bin/burrow service status
~/.burrow/bin/burrow service restart
~/.burrow/bin/burrow service logs
~/.burrow/bin/burrow service stop
~/.burrow/bin/burrow service start
~/.burrow/bin/burrow service uninstall
```

The service uses `~/.burrow/burrow.env` and starts `~/.burrow/bin/burrow serve`. It restarts after failures and is persistent across logout and reboot: installation requires `loginctl` to enable and verify systemd user lingering for the installing account. If lingering or systemd user services are unavailable, service installation fails rather than creating a session-only service; run `burrow serve` under your own supervisor for that case.

## Uninstall

Remove the application while preserving all durable state:

```sh
~/.burrow/bin/burrow uninstall
```

The command prompts before removing `app/` and the launcher. To remove the entire Burrow home, including configuration, workspace, sessions, and other durable state:

```sh
~/.burrow/bin/burrow uninstall --purge
```

For non-interactive use, include `--yes` explicitly:

```sh
~/.burrow/bin/burrow uninstall --purge --yes
```

## Docker

The published image stores all durable runtime state in `/data`. It runs as the dedicated `burrow` identity with UID/GID `4226:4226`; the image build accepts `BURROW_UID` and `BURROW_GID` build arguments when another deliberate numeric identity is required. The supplied Compose file pins `4226:4226` and publishes TCP `42817` for Burrow plus TCP `7443` for authenticated outbound Node Goblin connections. Control exposure with the host firewall, reverse proxy, and network policy appropriate to the deployment.

Existing persistent volumes must be writable by the configured numeric identity. For a disposable empty runtime, recreate the volume. For a runtime containing durable state, migrate only Burrow-owned data deliberately rather than recursively changing unrelated container or service data.

```sh
git clone https://github.com/NightShaman/Burrow.git
cd Burrow
docker compose up -d
```

Open `http://<docker-host>:42817`. The supplied mapping is remotely reachable; restrict it with the host firewall or a trusted reverse proxy according to the network and authentication model you intend.

To build the exact checked-out deployment payload instead of pulling the published image:

```sh
docker build -t burrow:local .
docker run --init --rm -p 127.0.0.1:42817:42817 -v burrow-data:/data burrow:local
```

Docker packaging is canonical in Burrow-Backend under `deploy/docker/`. A successful generated assembly materializes the root `Dockerfile`, `docker-entrypoint.sh`, `compose.yml`, and `.dockerignore`, then builds `ghcr.io/nightshaman/burrow` from that exact generated commit.

## Generated integration policy

`Burrow` is generated output. Human source changes belong in `Burrow-Backend` or `Burrow-UI`; the next assembly can overwrite generated snapshots.

After a verified source push, `.github/workflows/assemble.yml`:

1. resolves the triggering source revision and the configured revision of the other source;
2. tests the backend and UI, builds the UI, and writes immutable source SHAs to `SOURCE_VERSIONS`;
3. commits the assembled application, installer, and Docker assets to `main`;
4. builds and publishes `ghcr.io/nightshaman/burrow:sha-<Burrow commit>` and `ghcr.io/nightshaman/burrow:latest` from that generated commit.

The assembly requires a `BURROW_SOURCE_TOKEN` repository secret to fetch the source repositories and publish the image. Source repositories use `BURROW_DISPATCH_TOKEN` to request an assembly after their own verification succeeds.

## Mods

Mods are separate from the Burrow product repository. Install them beneath the active runtime root, normally `~/.burrow/mods/<mod-id>`, and restart Burrow after installation. Burrow discovers a mod from its `burrow.mod.json` manifest.

For example, the Node Goblin mod is maintained at <https://github.com/NightShaman/Node-Goblin>:

```sh
mkdir -p "$HOME/.burrow/mods"
git clone https://github.com/NightShaman/Node-Goblin.git \
  "$HOME/.burrow/mods/node-goblin"
```
