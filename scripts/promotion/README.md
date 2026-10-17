# Public promotion

NightShaman repositories are the private development authority. The daily
promotion workflow publishes reviewed, allowlisted snapshots to the public
`GoblinKing-Burrow` account:

- `Burrow`
- `Node-Goblin`
- `Goblin-Secret-Store`
- `Burrow-Skills`

## Release contract

- Freeze exact 40-character development SHAs once per run.
- Compare them with the last public `PUBLIC_RELEASE.json` manifest.
- Release only changed targets, in dependency order, under one plain UTC
  `YYYY.MM.DD` identity. Never allocate `.N` revisions.
- A target already published that UTC day is immutable; later changes wait for
  the next UTC day.
- Node Goblin owns its tarball and checksum.
- Burrow owns its assembled source snapshot and GHCR image.
- GSS and Skills own their public source snapshots.
- Public snapshots use explicit allowlists. Development workflows, audit notes,
  secrets, caches, runtime data, and Git history are not mirrored.
- Publication credentials are available only in the environment-gated publish
  job, after staging and verification succeed.
- Published tags and assets are immutable. A partially completed run resumes
  idempotently from the same frozen release manifest.

The active workflow is `.github/workflows/daily-public-promotion.yml`. It runs at
05:30 UTC and supports manual dispatch. The `public-promotion` environment and
these Actions secrets are required in the private NightShaman Burrow repository:

- `PUBLIC_PROMOTION_SOURCE_TOKEN`: read access to required NightShaman sources.
- `PUBLIC_PROMOTION_DESTINATION_TOKEN`: write access to the four public
  repositories, releases, and `ghcr.io/goblinking-burrow/burrow`.

## Local verification

```sh
node --test scripts/promotion/*.test.mjs
node scripts/promotion/validate-public-readiness.mjs ..
```

`targets.json` declares dependency fingerprints. `plan.mjs` creates the
immutable release plan. `stage-snapshots.mjs` materializes explicit public trees.
`publish-snapshot.sh` replaces only a destination snapshot and refuses to move an
existing release tag.
