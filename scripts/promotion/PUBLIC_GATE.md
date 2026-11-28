# Public release gate classification

The scheduled/validation-only promotion gate tests frozen revisions, then stages the same allowlisted trees and smokes the exact image later published. The release remains UTC date-only (at most once per date); this change does not alter Development assembly. A failed essential check blocks promotion. The backend selector lives in `public-critical-backend.json` in this orchestrator, not an editable backend npm script; `run-critical-backend.mjs` verifies every path exists at the frozen backend SHA and invokes its isolated `test:files` runner with a disposable PostgreSQL 17 fixture.

| Critical backend selection | Why it blocks Public |
| --- | --- |
| postgres-migration-baseline | real old-ledger upgrades, repeat migration, encrypted settings and checkpoint preservation across dump/restore |
| portable-install-restore | failed activation preserves previous installation and rollback state |
| postgres-http-routes.integration | SQL-backed agent/task routes actually round-trip over HTTP |
| chat-input-http.integration | authenticated durable chat, cancellation, restart and recovery over HTTP |
| developer-tools, mcp-runtime-tools | real native filesystem proposal and MCP grants/menu execution contracts |
| ui-auth-service | cookie integrity, expiry and credential rotation |
| provider-pool-replay, provider-pool-failure-preservation | safe alternate routing, replay proofs, upstream errors and non-retryable output |

Other essential component checks (UI tests/build, gateway tests, secret-store build/tests, Backdoor checks, Tutor/Theater build/tests, Switchboard tests/build/core, Auditor and Plug-ins build/unit/Core integration, and official Auditor skill presence), staged readiness and packaged smoke still block promotion. The complete backend suite including performance/scale tests and rendered browser docs are **not** release-latency blockers: manually run `Public deep regression and rendered docs (non-publishing)` to see regression/docs failures in GitHub Actions (failure-only summary). This workflow has no publication job or schedule. The separate docs workflow continues to validate docs edits. Neither a passing critical selection nor a green packaged smoke claims comprehensive coverage.
