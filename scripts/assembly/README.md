# Assembly trust gate

Assembly owns only the generated Burrow runtime and release payload: `backend/`,
`ui/`, root container files, the Burrow installer, and `SOURCE_VERSIONS`. The
Burrow repository owns `README.md`, `docs/` and its artwork, license/governance
files, and workflow configuration. Those curated files are neither deleted nor
copied from component repositories during assembly. Optional mods own their own
versions, installers, and release assets; Burrow assembly neither checks them out
nor republishes them.

Both repository dispatch and manual dispatch resolve Backend/UI refs through the
GitHub commits API before comparing forward-only pins, checking CI or checking out
sources. A delayed non-forward dispatch continues to fail closed.

The only accepted evidence is a completed successful `push` run on `main` for the
exact resolved SHA of `.github/workflows/notify-burrow.yml` (workflow name
`Verify and assemble Burrow`) in the corresponding component repository. The
workflow ID is resolved from that exact file via GitHub's API and matched against
every run. PRs, unrelated workflows and different SHAs do not qualify. API errors,
missing evidence, inactive/renamed workflows and failed runs fail closed.

In-progress runs are awaited (the dispatch occurs before the component workflow
has fully completed). `COMPONENT_CI_TIMEOUT_MS`, an assembly repository Actions
variable, sets the waiting deadline in milliseconds; default 3600000 (one hour).
There is no polling-attempt limit. A deadline expires closed and can be followed
by a fresh manual dispatch after component CI succeeds. The latest trusted retry
supersedes earlier evidence. Queries paginate so history is not arbitrarily cut.

Run gate regressions: `node --test scripts/assembly/component-gate.test.mjs`.

Assembly does not rerun comprehensive component suites. After the exact-SHA
trusted component gate, it builds the deployment image once with `load: true`,
`push: false`, and the UI SHA build argument. The real packaged launcher starts
with the image's bundled managed PostgreSQL in a disposable named container and
volume on a random localhost port. Smoke validates `/health` version, all release
provenance pins and a per-run token, launcher executability, and served UI index,
JS/CSS assets and UI SHA. It enables disposable Basic auth, proves unauthenticated
schema access is denied, then authenticates and parses `/api/openapi.json` for the
current sessions operation and fetches `/api/docs` plus both locally served Scalar
assets. The same assembled root is passed through the native installer with an
isolated home and `--no-install-dependencies --no-service`; it verifies the
installed schema bytes and assets but does **not** claim native HTTP readiness.
Only `backend/docs/openapi.json` is shipped from the canonical backend docs tree;
source-only npm OpenAPI generation/check scripts may need other canonical docs and
are not release validation commands. Disposable container/volume and native home
are removed on success and failure. Only after smoke passes are the assembly and
the very same local image tags published; no rebuild.

Run all contracts: `node --test scripts/assembly/*.test.mjs`.
Run smoke: `node scripts/assembly/packaged-smoke.mjs IMAGE ASSEMBLED_ROOT`.
For sudo-only Docker, supply `BURROW_SMOKE_DOCKER` pointing to an executable wrapper
that runs `sudo docker "$@"`. No host PostgreSQL or registry credentials are needed.

### NightShaman Releases

Successful assemblies publish a normal GitHub release marked Latest in the
NightShaman repository after packaged smoke checks and container publication.
The existing UTC build version identifies the release. Assets contain the exact
committed installable assembly, SOURCE_VERSIONS and SHA256SUMS; notes link the
workflow, source revisions and immutable image. This is independent of public
promotion/releases under GoblinKing-Burrow (no prerelease flag or manual pinning).
