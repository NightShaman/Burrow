# Provider error acceptance fixture

Production Chat, terminal parser, side-question reconciliation and styles; synthetic data only. `window.fetch` rejects all calls and the static server should use `connect-src 'none'`. No live generation, settings, or runtime mutation.

Build using `node scripts/provider-error-fixture/build.mjs`. Serve the `bundle` directory through a CSP-isolated static server. Compare a baseline bundle under `/before` and candidate under `/after` with:

```
PROVIDER_ERROR_FIXTURE_URL=http://127.0.0.1:PORT \
PROVIDER_ERROR_EVIDENCE=/tmp/provider-error-evidence \
node scripts/provider-error-fixture/headless.mjs
```

Uses disposable Chromium, actual 1920×1200 screenshots, overflow checks, real keyboard activation of existing error Copy, captured clipboard payload, provider/fallback/partial/side-question/local/long/success states and reload. The fixture intercepts browser clipboard API and fallback solely to inspect copied text without touching the system clipboard. Hook regressions separately test stream and persisted-session/cache hydration. Backend sanitization is covered in the backend, not simulated here.
