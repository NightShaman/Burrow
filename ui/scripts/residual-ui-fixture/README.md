# Residual UI acceptance fixture

Imports the real `useChatSession`, `ChatTranscript`, and `GroupChannelsPage`; no copied production behavior. All fetches are replaced by in-memory deferred responses. The static server cannot proxy APIs; CSP prohibits connections. No live sends, provider calls, settings writes or deployment.

```sh
node scripts/residual-ui-fixture/build.mjs
node scripts/residual-ui-fixture/headless.mjs
```

Chromium uses a disposable profile and 1920×1200 viewport. Override `CHROMIUM_BIN` or `RESIDUAL_EVIDENCE_DIR` as needed. The runner asserts session/agent/return navigation, two independently pending older loads, stale completion fencing, acknowledged send with failed refresh, cleared submitted or retained newer draft, and failed/successful refresh retry issuing exactly one POST total. It captures PNGs, DOM observations, mocked requests and real network origins in `results.json`. Inspect the screenshots as well as assertions.

For a before comparison, copy this fixture to a detached baseline checkout, build there and set `EXPECT_BEFORE=1`; the same runner records the known blocked load and misleading send error rather than expecting the corrected behavior. It never contacts a backend.

`serve.py` binds a random LAN-visible port solely to allow the granted remote DevTools browser to inspect the mocked bundle. Stop that process after inspection. Do not run on an untrusted network.
