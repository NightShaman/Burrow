# Public promotion

NightShaman repositories are the private development authority. The daily
promotion workflow publishes reviewed, allowlisted snapshots to the public
`GoblinKing-Burrow` account:

- `Burrow`
- `Node-Goblin`
- `Goblin-Secret-Store`
- `Burrow-Skills`
- `Burrow-Backdoor`
- `Burrow-Tutor`
- `Burrow-Theater`

## Release contract

- Freeze exact 40-character development SHAs once per run.
- Compare them with the last public `PUBLIC_RELEASE.json` manifest.
- Release only changed targets, in dependency order, under one plain UTC
  `YYYY.MM.DD` identity. Never allocate `.N` revisions.
- A target already published that UTC day is immutable; later changes wait for
  the next UTC day.
- Node Goblin owns its version, source snapshot, bootstrap installer, tarball, and checksum. Node Goblin changes do not create a Burrow release.
- Burrow owns only its assembled source snapshot and GHCR image; Burrow releases do not contain Node Goblin assets or adopt Node Goblin's version.
- GSS, Skills, Backdoor, Tutor, and Theater own their public source snapshots.
- Complete Backend, UI, Node Goblin, GSS/Core integration, Backdoor/Core integration, installer, assembly, and packaged-image validation runs here against the frozen source set before publication. NightShaman push workflows remain fast development gates.
- Public GitHub releases use coordinated notes generated from the NightShaman commit ranges since the previous public manifest, with generated assembly/release commits omitted.
- Public snapshots use explicit allowlists. Development workflows, audit notes,
  secrets, caches, runtime data, and Git history are not mirrored.
- Publication credentials are available only in the environment-gated publish
  job, after staging and verification succeed.
- Published tags and assets are immutable. A partially completed run resumes
  idempotently from the same frozen release manifest.

The active workflow is `.github/workflows/daily-public-promotion.yml`. It runs at
05:30 UTC and supports manual dispatch. A manual `validate_only` run executes the
complete frozen-source gate without publishing, including when today's immutable
release already exists. The `public-promotion` environment and
these Actions secrets are required in the private NightShaman Burrow repository:

- `PUBLIC_PROMOTION_SOURCE_TOKEN`: read access to required NightShaman sources, including Theater.
- `PUBLIC_PROMOTION_DESTINATION_TOKEN`: write access to the seven public
  repositories, releases, and `ghcr.io/goblinking-burrow/burrow`.

The destination repositories must already exist. In particular,
`GoblinKing-Burrow/Burrow-Backdoor`, `GoblinKing-Burrow/Burrow-Tutor`, and `GoblinKing-Burrow/Burrow-Theater` must exist before promotion;
the publisher intentionally does not create repositories implicitly.

## Local verification

```sh
node --test scripts/promotion/*.test.mjs
node scripts/promotion/validate-public-readiness.mjs ..
```

`targets.json` declares dependency fingerprints. `plan.mjs` creates the
immutable release plan. `stage-snapshots.mjs` materializes explicit public trees.
`publish-snapshot.sh` replaces only a destination snapshot and refuses to move an
existing release tag.
