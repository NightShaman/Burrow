# Assembly trust gate

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
JS/CSS assets and UI SHA. Cleanup runs on success and failure. Only after smoke
passes are the assembly and the very same local image tags published; no rebuild.

Run all contracts: `node --test scripts/assembly/*.test.mjs`.
Run smoke: `node scripts/assembly/packaged-smoke.mjs IMAGE ASSEMBLED_ROOT`.
For sudo-only Docker, supply `BURROW_SMOKE_DOCKER` pointing to an executable wrapper
that runs `sudo docker "$@"`. No host PostgreSQL or registry credentials are needed.
