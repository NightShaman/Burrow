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

## Executable permissions in promoted source

Current promotion packages the validated source trees inside a tar archive before the Actions artifact handoff. Uploading loose files at that boundary loses executable modes. After extraction, promotion verifies the recorded executable-file manifest and checks both Burrow and Node Goblin installers before publishing snapshots, assets or images.

This fixes the packaging boundary for subsequent promotions; it does not repair an already downloaded tree or replace immutable older tags. If a native install fails because the downloaded source's `install.sh` is not executable, record the source version and inspect its file mode. Use a corrected, verified release snapshot rather than assuming that invoking the outer installer with `bash` repairs the downloaded source. See [installation troubleshooting](../operations/troubleshooting.md#downloaded-installer-is-not-executable).

## Coordinated public promotion and tested image identity

Checked **7 November 2026**: a change in the frozen source set now triggers one coordinated release of all configured public targets in dependency order, under a plain UTC `YYYY.MM.DD` identity. A release already published for that UTC day remains immutable; later changes wait for the next day. Components retain their own source and asset ownership. A Node Goblin change can trigger the coordinated release without moving its installers or archives into Burrow's release.

The public Burrow image is smoke-tested, archived with its image ID and checksum, restored for publication and pushed without rebuilding. The tested local image ID and remote tag manifest digests are different identifiers; verify the recorded provenance rather than equating them. Publication remains separate from updating an installed instance.
