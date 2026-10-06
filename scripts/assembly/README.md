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

The comprehensive assembly suites are intentionally still present until a real
packaged runtime smoke is implemented and verified; removing them prematurely
would leave an unverified boundary. The runtime currently initializes PostgreSQL
before binding its HTTP listener; a synthetic health server is not equivalent to
an actual packaged launcher smoke.
