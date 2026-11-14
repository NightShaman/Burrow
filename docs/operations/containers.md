# Containers


!!! note "Implementation and historical evidence"

    Reviewed against current implementation on **8 November 2026**. Historical commit links and explicitly dated examples remain historical evidence; they do not identify the current development source or certify your installed version. See [source coverage](../project/source-map.md). This is static source reconciliation, not a live application or provider test.


The assembled repository supplies the canonical `Dockerfile`, `docker-entrypoint.sh`, and `compose.yml`. The public release image is `ghcr.io/goblinking-burrow/burrow`.

## Start with an explicit configuration

This core-only example builds from the checked-out assembled source and binds to loopback on the Docker host. Run it from the pinned checkout described under [Build from the assembled checkout](#build-from-the-assembled-checkout). It intentionally shows only the core HTTP port:

```yaml
services:
  burrow:
    build: .
    image: burrow-local:2026.10.19
    init: true
    user: "4226:4226"
    environment:
      HOME: /home/burrow
    ports:
      - "127.0.0.1:42817:42817"
    volumes:
      - burrow-data:/data
    restart: unless-stopped

volumes:
  burrow-data:
```

```sh
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 burrow
```

The local tag above names the reviewed source snapshot; it is not a claim that a matching registry tag was checked. To use the published image instead, remove `build`, select an existing explicit registry tag or digest, and use `docker compose pull` before startup. Verify that published artifact separately; `latest` is a moving tag. The repository's root Compose example publishes on all host interfaces and has no explicit restart policy, so review it before use.

Open `http://127.0.0.1:42817` on the Docker host and follow [initial setup](../getting-started/initial-setup.md). Remote access requires deliberate port/proxy configuration and [authentication](../security/authentication.md).

## Host access with Node Goblin

For agents that need files or commands on the Docker host, we recommend running the **Node Goblin host runtime natively on that host** and assigning the agent to that gateway. This avoids exposing the host root inside Burrow or making its container privileged merely for host workspace access. **Local controller** execution still stays inside the Burrow container.

For the native runtime on the same machine, use **`localhost:7443`** as its controller address, not the web-interface port. With ordinary Docker bridge networking, enable the Host Gateway controller with a listener on `0.0.0.0:7443` inside the container and add this same-host-only mapping beside the existing web port:

```yaml
ports:
  - "127.0.0.1:42817:42817"
  - "127.0.0.1:7443:7443"
```

Recreate the container after changing Compose port mappings. Container loopback alone cannot receive bridge-forwarded traffic. With Linux host networking, the controller can instead listen on host loopback directly; `ports` mappings do not apply. Remote nodes need a reachable hostname/address and deliberately exposed controller port, not `localhost`.

Install and pair the native runtime, then select its **Configured gateway** target and a host workspace for the agent. Host service-account permissions still apply; the workspace is not a sandbox, and Docker access is a separate privileged capability. Keep a local or SSH recovery path when maintaining the Burrow container or Node Goblin service.

See [Node Goblin's Docker-host setup](https://docs.goblin-kingdom.com/node-goblin/installation/#burrow-in-docker-run-node-goblin-on-the-host) for installation, pairing, and networking details.

## Image layout

| Item | Default |
|---|---|
| Build/runtime base | Node 24, Debian Bookworm |
| Application | `/opt/burrow` |
| Runtime state volume | `/data` |
| User/group | Numeric UID/GID `4226:4226` |
| User home | `/home/burrow` |
| HTTP listener | `0.0.0.0:42817` inside container |
| Database lifecycle | Managed PostgreSQL 17 with pgvector |

The image builds the UI in a separate stage and installs backend production dependencies. Build-time `BURROW_UID` and `BURROW_GID` arguments customize the account. A bind-mounted directory must be writable by the selected numeric identity; a matching host username is not sufficient.

## Encryption key and startup integrations

The entrypoint reads or creates `/data/config/settings.key`, unless `BURROW_SETTINGS_KEY_FILE` changes the path. If a supplied `BURROW_SETTINGS_KEY` disagrees with the persisted file, startup stops. Restore the matching key/database pair instead of deleting the key file.

The entrypoint also provisions runtime-owned CLI integrations below `/data/integrations`. mcporter is pinned to `0.13.7`; current reviewed Core pins Claude Code to `2.1.283`. Startup can require npm network access to materialize these declared versions. Historical source snapshots may use different integration versions; check the installed integration manifest rather than assuming the current pin applies to an older image. Plan egress and reproducibility requirements accordingly.

## External database

Add a private environment file to the service:

```yaml
services:
  burrow:
    env_file:
      - ./external-postgres.env
    environment:
      HOME: /home/burrow
      BURROW_POSTGRES_LIFECYCLE: external
```

Use the connection/TLS settings in [deployment](deployment.md#external-postgresql). The external database must be PostgreSQL 17 with pgvector and migration privileges. Keep `/data` persistent even with an external database: keys, artifacts, integrations, and other runtime files still matter.

## Healthcheck meaning

The image probes `/api/health` every 10 seconds with a 5-second timeout, 20-second start period, and six retries. HTTP success or **401** counts as liveness. This accommodates authenticated installations but does not prove successful model/tool execution. Inspect the public build identity and authenticated runtime status and complete a chat as separate acceptance checks.

## Upgrade and backup

Before replacing the image, make a [recoverable backup](backup-recovery.md). For a managed database, stop the container cleanly before an ordinary raw `/data` filesystem copy; keep the complete volume, including PostgreSQL and the settings key.

After changing the release tag:

```sh
docker compose pull
docker compose up -d
docker compose logs --tail=100 burrow
```

Do not run the native `burrow update` procedure inside a container as a substitute for replacing its image. Do not use `docker compose down --volumes` as routine maintenance; it removes named volume state.

## Build from the assembled checkout

```sh
git clone https://github.com/GoblinKing-Burrow/Burrow.git
cd Burrow
git checkout aa5a30da683a3a8ea919025f107ff53f182ef8d6
docker build -t burrow-local:2026.10.19 .
```

This is a build command, not a deployment to an existing runtime. The build needs access to npm, Debian/PGDG packages, and base images.




## Targeted source review

The full page was reconciled statically on **8 November 2026** against the current source pins in [source coverage](../project/source-map.md). Links below retain historical revision evidence. No application, database, provider or collector test was run.

- [Dockerfile](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/Dockerfile)
- [docker-entrypoint.sh](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/docker-entrypoint.sh)
- [SOURCE_VERSIONS](https://github.com/GoblinKing-Burrow/Burrow/blob/aa5a30da683a3a8ea919025f107ff53f182ef8d6/SOURCE_VERSIONS)
