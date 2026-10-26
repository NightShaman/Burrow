# Compact footer acceptance

Actual `AppStatusBar` and polling component, synthetic combined native OpenAI LB response, in-memory fetch only. CSP denies connections; no runtime writes, accounts, or model calls.

Run `node scripts/pool-metrics-fixture/build.mjs && node scripts/pool-metrics-fixture/headless.mjs`.

Checks 1920×1200, 2133×1333 (1920×1200 at 90% CSS viewport equivalent), 1100×900 and 720×900. Desktop footer fits with three existing usage meters; narrower footer scrolls without truncation. Checks selector, nulls, partial-cache tooltip and no selector refetch. Screenshots: `/tmp/smatchet-metrics-*.png`.
