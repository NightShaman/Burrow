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
- `Burrow-Switchboard`
- `Burrow-Auditor` (Auditor)
- `Burrow-Plug` (Plug-ins)

## Release contract

- Freeze exact 40-character development SHAs once per run.
- Compare them with the last public `PUBLIC_RELEASE.json` manifest.
- When any frozen source changes, release all targets together in dependency order
  under one plain UTC `YYYY.MM.DD` identity. Never allocate `.N` revisions.
- A coordinated release already published that UTC day is immutable; later changes wait for
  the next UTC day.
- Public skill `SKILL.md` frontmatter versions are stamped with that same plain
  release date during staging, before validation and publication. Development
  `.N` authoring versions remain in NightShaman only. All official public skills
  must match their `PUBLIC_RELEASE.json`; only the version field is rewritten.
- Node Goblin owns its version, source snapshot, bootstrap installer, tarball, and checksum. A Node Goblin change triggers the coordinated release, including Burrow, without transferring asset ownership.
  Its checksum-validated release asset is built once from the frozen staged
  source and carried unchanged through the artifact boundary, with the public
  bootstrap's repository authority checked before publishing.
- The public Burrow image is smoke-tested once, archived with its image ID and
  checksum, restored in the publish job, and pushed under both tags without a
  rebuild. Local tested-image ID and remote per-tag manifest digests are checked
  and written to the promotion run summary. The local-store ID from Docker
  `.Id` can be either a config digest (classic store) or an OCI index digest
  (containerd store); it remains the publisher's restore/tag/pull identity.
  There is one runtime platform; BuildKit may wrap its manifest and
  provenance attestations in an OCI index. The terminal verifier follows the
  digest-bound runtime manifest without mistaking its config ID for that index.
- Burrow owns only its assembled source snapshot and GHCR image; Burrow releases do not contain Node Goblin assets or adopt Node Goblin's version.
- GSS, Skills, Backdoor, Tutor, Theater, Switchboard, Auditor, and Plug-ins own their public source snapshots.
- Complete Backend, UI, Node Goblin, GSS/Core integration, Backdoor/Core integration, Auditor/Core integration, Plug-ins/Core integration, installer, assembly, and packaged-image validation runs here against the frozen source set before publication. NightShaman push workflows remain fast development gates.
- Public GitHub releases use coordinated notes. Auditor and Plug-ins use public
  summaries keyed to source changes. The existing targets use NightShaman
  commit ranges since the previous public manifest and omit generated
  assembly/release commits.
- Public snapshots use explicit allowlists. Development workflows, audit notes,
  secrets, caches, runtime data, and Git history are not mirrored.
- Staged trees, manifests and release notes cross the Actions artifact handoff
  inside a tar archive. Loose artifact files lose executable permissions. A
  manifest of every staged executable is checked after extraction, before any
  Git snapshot, release asset or image is published; both installers must also
  remain executable. Hidden files stay inside the already-allowlisted tree.
- Publication credentials are available only in the environment-gated publish
  job, after staging and verification succeed.
- Published tags and assets are immutable. A partially completed run resumes
  idempotently from the same frozen release manifest.

The active workflow is `.github/workflows/daily-public-promotion.yml`. It runs at
05:30 UTC and supports manual dispatch. A manual `validate_only` run executes the
complete frozen-source gate without publishing, including when today's immutable
release already exists. The `public-promotion` environment and
these Actions secrets are required in the private NightShaman Burrow repository:

- `PUBLIC_PROMOTION_SOURCE_TOKEN`: read access to required NightShaman sources, including Auditor, Plug-ins and Skills.
- `PUBLIC_PROMOTION_DESTINATION_TOKEN`: write access to the ten public
  repositories, releases, and `ghcr.io/goblinking-burrow/burrow`.

The publisher requires all ten destination repositories to exist, including
`GoblinKing-Burrow/Burrow-Auditor` and `GoblinKing-Burrow/Burrow-Plug`.

## Auditor and Plug-ins prerequisites

- Both frozen mod revisions need a tracked `LICENSE` and their existing
  `docs/assets/hero.png` (preserved at its native aspect), and the runtime paths in `companion-snapshots.mjs`.
  Keep the public file list current when either mod adds or moves a module.
  Staging supplies the public READMEs and runtime-only package metadata.
- Auditor uses the generic mod minion bridge, execution-host discovery,
  owner-scoped completion feeds, caller-bound `mod_wait` and managed skills.
  The inspected Auditor source declares Core minimum `2026.11.27.3`. The
  frozen Skills revision must contain `burrow-auditor/SKILL.md`. The Auditor
  manifest registers it from the Public Skills repository, and promotion
  publishes Skills before Auditor.
- Plug-ins needs Core's registry-derived agent identity metadata and the
  native mod Settings contribution and shared draft guard in the assembled
  UI. The inspected Plug-ins source declares Core minimum `2026.11.26.2`.
  Its public legacy Outlook catalog and digest-verified connector are
  served from the same immutable Plug-ins tag.
- Both mod Core suites use the pinned Backend and disposable PostgreSQL 17.
  Auditor uses its lockfile for test dependencies. Plug-ins bundles its
  validator and currently declares no dependencies. The daily gate runs both
  build, unit and Core integration suites and validates the staged manifests
  with the pinned Core parser. Browser and live account checks are separate.
- Users add the public repository URL in **Settings → Mods → Mod sources**,
  refresh the source, then install or update and enable the mod.

## Public outcome checks

The publish job checks Burrow once and checks Auditor and Plug-ins once each
when the restored artifact includes them. Each check runs after the publication
steps, including when an earlier publication or outcome step failed, provided
restore succeeded. `verify-public-outcome.mjs prepare` runs
before any publication. It validates the intended date, original run/manifest,
frozen plan sources, publish disposition and `tested-image.json`. From the
checksum-validated `tested-image.tar.gz`, it reads the single Docker-save
`manifest.json` entry and hashes its referenced config bytes, checking the
content-addressed filename. Classic `<digest>.json` and containerd
`blobs/sha256/<digest>` layouts are supported without changing old artifact
schemas. Missing/malformed metadata, duplicate members, multiple image entries
or checksum/config-digest disagreement fail before publication. It records:

- the Git tree of the restored `staged/Burrow` payload, calculated with a
  disposable Git directory/index and the publisher's `git add -A` / `write-tree`
  semantics (not the development assembly commit SHA);
- the Git trees of the restored Auditor and Plug-ins payloads using the same
  semantics, with each intent bound to its public repository and the original
  release date;
- the exact archived smoke-tested **config digest** required by the canonical
  verifier and fixed public image repository, not an assumed Docker `.Id`.
  `tested-image.json.imageId` is unchanged: the publisher still compares the
  smoke-tested local-store identity on restore, tag and existing-date pull;
- the original Actions run, the named `public-promotion-YYYY.MM.DD` tar artifact
  (`actions-artifact:` provenance reference, not a download URL), and the current
  handling run/attempt URL. A resumed run keeps the **original date and artifact
  origin**, even when handled on a later UTC date.

`verify-public-outcome.mjs verify` dynamically imports the assembled canonical
Backend `backend/src/outcome-verification.mjs`. It independently observes each
intended repository's exact public, non-draft, non-prerelease GitHub release
and the date tag's source tree. Burrow also requires the anonymous GHCR date
tag's single-platform image config identity. Missing or unusable canonical
verifier code produces an unverified receipt.

Burrow's `public-outcome.json` is uploaded as
`public-outcome-<date>-<handling-run>-<attempt>`. The two companion receipt files
are uploaded as `public-companion-outcomes-<date>-<handling-run>-<attempt>`.
Both artifacts retain available receipts for seven days, including on
publication or check failure. Only `verified` returns zero. A `mismatch` or
`unverified` receipt fails the job. Earlier publication failures still fail the
job if a subsequent check verifies.

Unchanged, deferred and `validate_only` invocations skip publication and these
checks. Restore or identity failure prevents publication and outcome checks.
Resuming an original eight-target artifact checks Burrow's release, source and
image under the artifact's original date.

## Local verification

```sh
node --test scripts/promotion/verify-public-outcome.test.mjs
node --test scripts/promotion/*.test.mjs
node scripts/promotion/validate-public-readiness.mjs staged sources/Burrow-Backend
```

The outcome adapter tests use disposable Git, synthetic Docker archive fixtures,
and mock HTTP responses through the canonical verifier. Workflow tests check
step order and failure conditions. Live publication is outside these tests.

`targets.json` describes target repositories, provenance source subsets and asset
metadata. `plan.mjs` compares the complete frozen source set once: any change
stages every target together (unless that UTC date is already published).
Per-target fields are descriptive plan/artifact metadata, not independent
publication gates; the workflow consumes the overall `publishable` decision
and release date. `stage-snapshots.mjs` materializes explicit public trees.
`publish-snapshot.sh` replaces only a destination snapshot and refuses to move an
existing release tag.

### Restart after the final snapshot push

`PUBLIC_RELEASE.json` records the originating Actions run ID. A new invocation
checks the terminal, non-draft Burrow GitHub Release before deciding sources are
unchanged. If that release is missing, it downloads **the original validated tar
artifact** from that run and resumes the same date with the original frozen sources and target
set. An artifact from before Auditor and Plug-ins were introduced finishes its
original eight targets. A fresh promotion freezes both added sources. Missing/expired artifacts fail closed (currently retained
seven days). Recover the original run/artifact rather than minting another version.
Legacy incomplete manifests without an origin ID also fail closed and require
operator recovery of their original frozen artifact. A validate-only invocation
is rejected while publication is pending, rather than claiming validation ran.
API failures other than a definitive 404 never authorize a resume.
