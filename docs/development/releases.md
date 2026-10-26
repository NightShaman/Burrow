# Releases

## Public versions

Burrow public versions use the UTC date format **YYYY.MM.DD**. Check the [public release notes](https://github.com/GoblinKing-Burrow/Burrow/releases) before updating, including any migration or recovery requirements.

Public container images use:

- `ghcr.io/goblinking-burrow/burrow:latest`
- `ghcr.io/goblinking-burrow/burrow:<calendar-version>`

Use a reviewed calendar-version tag to select a release, and pin its image digest when you need immutable deployment identity. Tags can move; `latest` is explicitly a moving selection. Record the digest, source provenance and reported running version together.

## Updating your installation

Publishing a release does not update a running installation. Native operators run `burrow update`; container operators replace their image and recreate the container while preserving runtime data.

Before updating, back up the database, runtime files, and matching encryption key. Afterward, check the reported version, model connections, and enabled integrations. See the [current maintenance guide](../guide/maintenance.md) for upgrade, backup, and troubleshooting steps.


## Development and documentation provenance

Development assembly builds use a date with an optional same-day counter (for example `2026.10.25.9`), independently of the public daily promotion version. A documented current-source feature is not proof that a public tag or installed runtime already contains it. Consult the source/coverage record and the exact release artifact before relying on it.

Development assembly now also publishes a versioned source archive of the exact assembled commit, its `SOURCE_VERSIONS`, and `SHA256SUMS`. Verify the downloaded archive against those checksums and its recorded source revisions. This development release is independent of public daily promotion; artifact publication does not update a running installation.

