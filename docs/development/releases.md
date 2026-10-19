# Releases

## Public versions

Burrow public versions use the UTC date format **YYYY.MM.DD**. Check the [public release notes](https://github.com/GoblinKing-Burrow/Burrow/releases) before updating, including any migration or recovery requirements.

Public container images use:

- `ghcr.io/goblinking-burrow/burrow:latest`
- `ghcr.io/goblinking-burrow/burrow:<calendar-version>`

Pin a calendar-version tag when you need a repeatable deployment. The `latest` tag can move to a newer release.

## Updating your installation

Publishing a release does not update a running installation. Native operators run `burrow update`; container operators replace their image and recreate the container while preserving runtime data.

Before updating, back up the database, runtime files, and matching encryption key. Afterward, check the reported version, model connections, and enabled integrations. See the [current maintenance guide](../guide/maintenance.md) for upgrade, backup, and troubleshooting steps.
