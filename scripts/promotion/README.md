# Public promotion (prepared, inactive)

NightShaman repositories remain development authority. Only reviewed public
snapshots are promoted to `GoblinKing-Burrow/Burrow`, `Node-Goblin`,
`Goblin-Secret-Store`, and `Burrow-Skills`.

This directory is preparation only. There is no active schedule, publisher,
credential, destination remote, or public repository creation. The workflow
template is deliberately outside `.github/workflows` and exits closed even if
moved accidentally.

## Release contract

- Freeze exact 40-character development SHAs once per run.
- Compare them with the last successfully published manifest before stamping.
- Release only changed targets, in dependency order, under one plain UTC
  `YYYY.MM.DD` identity. Never allocate `.N` revisions.
- A target already published that UTC day is immutable; later changes wait for
  the next UTC day.
- Node Goblin owns its tarball and checksum. Burrow references its compatible
  release; it does not duplicate Node Goblin assets.
- GSS and Skills own their Git snapshots. Burrow owns its image and assembly.
- Public snapshots use explicit allowlists. They never mirror `.git`, secrets,
  audit evidence, caches, runtime data, or unreviewed development workflows.
- Publication credentials are unavailable while source/build/test code runs.
- Partial cross-repository publication is recorded and resumed from the frozen
  plan; published tags and assets are never replaced.

`targets.json` declares destinations and dependency fingerprints. `plan.mjs`
creates a deterministic, read-only plan from frozen source SHAs and the previous
successful manifest. It does not publish anything.

```sh
node --test scripts/promotion/*.test.mjs
node scripts/promotion/plan.mjs scripts/promotion/targets.json sources.json previous.json
node scripts/promotion/validate-public-readiness.mjs ..
```

## Artwork gate

Every public README uses `docs/assets/hero.png`, displayed at width 720. The file
must be a transparent-capable PNG with a 1536x1024 canvas and useful alt text.
The validator checks dimensions and markup; light/dark GitHub rendering still
requires human review.

## Activation checklist

1. Add the four reviewed hero files and pass the readiness check.
2. Create the four empty public repositories under `GoblinKing-Burrow`.
3. Install a narrowly scoped GitHub App: read required NightShaman sources; write
   only the four public repositories/packages.
4. Implement and review target-specific staging allowlists and version stamping.
5. Run a credential-free dry run and compare every staged tree.
6. Run all component, package, docs, and assembled-runtime gates.
7. Protect public branches/tags and configure environments.
8. Replace the inert template with the reviewed publisher, then explicitly enable
   its daily schedule.

Until all eight steps are complete, NightShaman remains the only live authority.
