# Automatically use expiring resets: isolated UI acceptance

Build candidate: `node scripts/expiring-resets-fixture/build.mjs`
Build comparison: `node scripts/expiring-resets-fixture/build.mjs --before`
Run real Chromium checks: `node scripts/expiring-resets-fixture/headless.mjs`

The comparison substitutes only `ModelConnections.tsx` from delivered feature `ba9995c`; shell, realistic providers, viewport and other components are identical. No production settings or reset-credit endpoints are contacted. Fetch is replaced in-page; the owned headless server also sets CSP `connect-src 'none'`.

Current correction evidence is in `evidence/collapse/`: same-shell collapsed/expanded before/after at 1366×900, 1000×800, 480×900; hidden draft retention/reopen, account-switch disclosure, full-row width, enabled focus, mocked save failure, unsaved guard, and pool exclusion. `browser.json` records mock writes, dimensions, actual network URLs and exception checks. Mocked writes are true (failed), true (retry), false (disable). Nothing redeems a reset.

Original feature evidence remains in `evidence/`; its always-visible collapsed toggle expectation is superseded by the disclosure correction. Current gallery: `evidence/collapse/gallery.html`.

Serve browser-visible candidate: `python3 -m http.server 43343 --bind 0.0.0.0 --directory scripts/expiring-resets-fixture/bundle` (read-only fixture; do not use real app settings for validation).
