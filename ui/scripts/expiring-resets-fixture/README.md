# Automatically use expiring resets: isolated UI acceptance

Build candidate: `node scripts/expiring-resets-fixture/build.mjs`
Build comparison: `node scripts/expiring-resets-fixture/build.mjs --before`
Run real Chromium checks: `node scripts/expiring-resets-fixture/headless.mjs`

The comparison substitutes only `ModelConnections.tsx` from base `8ce9c0d`; the shell, CSS, realistic providers, viewport and other components are identical. No production settings or reset-credit endpoints are contacted. Fetch is replaced in-page; the owned headless server also sets CSP `connect-src 'none'`.

Evidence in `evidence/`: same-shell before/after at 1366×900, 1000×800, 480×900; enabled keyboard focus; mocked save failure; unsaved guard; pool exclusion; browser.json records mock writes, viewport measurements, actual network URLs and exception checks. Mocked writes are true (failed), true (retry), false (disable). Nothing redeems a reset.

Serve browser-visible candidate: `python3 -m http.server 43343 --bind 0.0.0.0 --directory scripts/expiring-resets-fixture/bundle` (read-only UI fixture; do not use real app settings for validation).
