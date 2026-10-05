# FE005 / FE051 disposable persistence acceptance

Run `node scripts/persisted-ui/run.mjs` from the UI checkout. Requires the sibling Backend fixture and PostgreSQL 17 binaries. No inherited DB credentials or environment are forwarded: Backend's owned runner creates a private Unix-socket cluster and removes it after stopping it. Fixture schema cleanup runs before cluster cleanup.

The Backend-owned helper uses actual settings routes and PostgreSQL stores. React runs separately under the unchanged Node/jsdom network-denial guards with a private HOME/tmp and no PG environment. Its narrowly enumerated API adapter exchanges requests through atomic files inside the owned runtime, not HTTP sockets. MCP catalog metadata is synthetic; grants reads/writes and model-selection reads/writes are real dispatcher/store operations. This is application-level test isolation, not an adversarial security sandbox.

FE005 switches from A to a failing B load, proves disabled Save/no grant writes, retries, saves B, remounts and reloads grants, and checks A unchanged. FE051 holds the first write, issues newer temperature/model intents while pending, releases it, checks only latest acknowledgement, then performs a fresh persisted GET and checks B remains untouched. This is hook/component acceptance, not full App browser acceptance or an HTTP transport test. Baseline-red reproduction is historical, not performed by this harness.

This suite is explicitly selected by its own config; ordinary `npm test` continues using its unchanged isolated runner.
