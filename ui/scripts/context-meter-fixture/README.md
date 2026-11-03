# Context meter fixture

Synthetic browser-local API, adapted from the existing compact UI harness. No live backend, paid API calls, or live service restart.

Run from UI root:

```
node scripts/context-meter-fixture/build.mjs --before
node scripts/context-meter-fixture/headless.mjs before-1920
node scripts/context-meter-fixture/build.mjs
node scripts/context-meter-fixture/headless.mjs after-1920
```

Before uses exact WorkspaceRail source at b1fcdf5 with identical synthetic API data to isolate UI differences. These screenshots do not prove backend highwater replacement; parent owns real-Core validation. Both show reported320k/capacity500k, matching estimate600k.

Personally image-reviewed both1920x1080 captures: identical layout/spacing/controls, no expansion or new panels. PNGs are byte-identical, expected for title/aria-label-only semantics. CDP evidence JSON records actual differing titles, unchanged meter rect, no document overflow and no runtime exceptions. Native browser title tooltip itself is not captured in PNG; text is verified via DOM evidence and unit tests.

Full UI suite:197 files passed;1764 tests passed,2 expected failures. Build passed (existing chunk-size advisory). Logs /tmp/burrow-context-ui-tests.log and /tmp/burrow-context-ui-build.log.
