# Native provider pool fixture

Synthetic OpenAI and Anthropic OAuth accounts; all `fetch` calls are intercepted in memory. The fixture server's CSP denies network connections. No real authentication, provider API calls, settings writes, or model generations.

```
node scripts/provider-pool-fixture/build.mjs
node scripts/provider-pool-fixture/headless.mjs
```

The owned Chromium runner checks both families, ordered membership, automatic-catalog payloads (no discovery or model selection), enabled/disabled round-trip, credential-free payloads, direct-account editing, separate Models/Load Balancing navigation and saved-list filtering, and column overflow at 1440×1000 and 1100×900. Temporary profile/server are cleaned up; screenshot evidence is written to `/tmp/smatchet-pool-{desktop,narrow}.png`.

For manual visual inspection, run `python3 scripts/provider-pool-fixture/serve.py` and open its printed port. Bundled files are ignored. Backend integration must be checked separately once pool endpoints are running.

The existing four-column Settings frame is not mobile-adaptive; at 720px its configuration/detail controls overflow their columns. This predates pools; the fixture deliberately tests supported desktop widths rather than changing unrelated Settings architecture.
