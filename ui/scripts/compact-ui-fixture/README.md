# Isolated `/compact` browser acceptance

Run from `/mnt/local/projects/Burrow-HC/Burrow-UI`:

```sh
node scripts/compact-ui-fixture/build.mjs
node scripts/compact-ui-fixture/headless.mjs
```

Requires checkout dependencies, Python 3, and `chromium` on PATH. No live app,
backend, credentials, Playwright install, or persistent browser profile needed.
The runner launches only its own loopback ephemeral static server and Chromium
CDP pipe, and cleans them up in `finally`. Build uses `configFile:false` (no Vite
API proxy); static responses carry `connect-src 'none'`. Every fetch is replaced
with an allowlisted browser-local mock, unknown routes throw, and CDP asserts no
actual API or external page requests. No changes to production components.

## Real UI under test

- `Chat` (production transcript and composer), `AgentsPanel` (production meter),
  and production CSS.
- `useChatSession`, `useChatRun`, `useRuntimeAgents`, their real repositories,
  stream parser, reconciliation, and browser cache behavior.
- Fixture wiring mirrors App's `onCompactionFinished -> refreshAgents` connection;
  this is a component/hook integration fixture, not full-App navigation coverage.

## Mock contract and assertions

Synthetic `POST /api/chat` validates the submitted `/compact`, agent, and session,
then returns real NDJSON via `Response/ReadableStream`. The start stage is held
until the runner captures it. Completion emits `context.compaction.completed`
and `run.completed` back-to-back to reproduce the terminal-stage batching race.
`POST /api/agents/overview` supplies context 82% before and 14% after success.
Session list/detail, activity, chat-input, steering, and composer-project routes
are mocked. The mock's own synthetic database is stored separately in
`compact-fixture.backend.v1`.

At 1280×900 and 375×900, assertions cover:

1. Visible accepted `/compact` and `Compacting context…` (not generic preparing).
2. Meter label **and fill** drop 82% → 14% within one second, exactly one
   completion callback/extra overview request, even with immediate termination.
3. Exactly one user command and final receipt, with no lingering live spinner.
4. Reload after deleting **all real UI caches**: command, persisted synthetic
   receipt, and 14% meter return through mock session/overview routes.
5. No-op receipt preserves 14%; failure displays error and preserves 14% without
   invoking the success refresh callback.
6. No horizontal page overflow, visible composer, no uncaught JS exceptions,
   unexpected mock routes, actual API requests, or external page requests.

Ignored output `evidence/report.json` contains timings, request/event receipts,
synthetic persisted turns, and geometry. Twelve PNGs capture before, compacting,
complete, cache-free refresh, no-op, and failure at each width. `bundle/` and
`evidence/` are ignored to avoid committing generated assets/screenshots.

## Scope

This validates frontend behavior against a deliberately simulated route contract;
it does not prove actual backend compaction, storage durability, token accounting,
or full-App wiring. Screenshots are recorded acceptance artifacts; automated
visual assertions are text, fill-style, and geometry checks, not pixel baselines.
