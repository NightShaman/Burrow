# Forge GIF visual acceptance fixture

Uses the real Forge component and app styles. All API requests are intercepted by an in-memory mock before mounting; unexpected requests fail. No backend/provider writes or paid generation. Use the existing UI dev server (no live restart):

- `/scripts/forge-gif-fixture/index.html` — capability-enabled and unsupported models
- `/scripts/forge-gif-fixture/index.html?state=error` — mocked submission rejection plus encoding failure

Run `node scripts/forge-gif-fixture/capture.mjs` to capture 1920×1200 PNG/GIF/unsupported/error states and a 900px narrow error state using disposable headless Chromium. Output defaults to `/tmp/forge-gif-evidence`; override `FORGE_EVIDENCE_DIR`. `EXPECT_BEFORE=1` records only the baseline image state, intended to run against the pre-change source.

The screenshots and observations are API-fixture UI evidence, not proof of live provider GIF generation. The captured shapes implement the contract agreed with Hatchet in `docs/verification/forge-gif/request.md`.

`catalog-capability.json` is a read-only snapshot of the final backend catalog capability. Run `node scripts/forge-gif-fixture/verify-contract.mjs` with the sibling `Burrow-Backend` checkout present to compare its actual catalog with this snapshot and pass real UI-generated still/GIF options through backend normalization. It checks both 2.6 models and unsupported omission; no job is dispatched. This optional cross-repository check is not part of the standalone UI build/test dependency graph.
