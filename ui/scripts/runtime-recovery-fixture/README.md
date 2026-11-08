# Runtime recovery acceptance

Synthetic-only real `useChatSession` and `AuthenticationSettings` fixture. Unknown fetches fail closed; no live backend, provider or settings changes.

Build: `node scripts/runtime-recovery-fixture/build.mjs`

Serve the generated bundle locally, then run:

```
RUNTIME_RECOVERY_EVIDENCE=/tmp/hatchet-runtime-recovery-20261108/ui RUNTIME_RECOVERY_FIXTURE_URL=http://127.0.0.1:43348 node scripts/runtime-recovery-fixture/headless.mjs
```

The existing Chromium CDP pipe mechanics exercise pending history/reset/obsolete release, fresh newest and older pages, and Authentication failed-load Retry recovery at 1920×1200. PNG capture and DOM/geometry assertions are not a substitute for direct visual review.
