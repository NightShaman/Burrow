# Isolated native thinking controls acceptance

From the Burrow-UI root:

```sh
node scripts/anthropic-thinking-fixture/build.mjs
node scripts/anthropic-thinking-fixture/headless.mjs
```

Uses checkout dependencies, Python 3 and `/snap/bin/chromium`. The runner owns a
static server, a disposable browser profile and CDP pipe; all are cleaned up.
No live API server, model credentials, provider discovery or generation is used.
The build sets `configFile:false`, so Vite's live API proxy is absent. CSP uses
`connect-src 'none'`; browser-local `fetch` mocks allow only synthetic endpoints.
Unknown routes throw, and the runner asserts zero real API/external page requests
and zero generation attempts.

Production `ChatModelSelector`, its selection writer, `Chat`, `Settings`, the
minion editor and production CSS are rendered in a shell matching App's chat
rails and current top-navigation Settings portal. It is component integration
acceptance, not a live-backend or full-App acceptance claim.

Sixteen screenshot states cover raw unsupported legacy Off, explicit
Adaptive/Default, incompatible mode/effort retained until corrected, pending and
rejected saves/retry, Manual, unchanged generic provider controls, minion
correction and null/null inherit. Native layout is checked at 1600, 1280, 800 and
390 pixels. Narrow Settings columns use the existing horizontal canvas scroll;
the runner scrolls the minion column into view and checks usable field widths.
The runner also checks Thinking→Effort keyboard focus, visible outline, exact
synthetic saved requests, blocked send until acceptance, and no uncaught errors.
The generic provider retains its pre-existing horizontally scrolling toolbar;
it is a regression control, not a claim that this slice redesigns that layout.

Ignored `evidence/` contains screenshots and `report.json`. Set
`NATIVE_FIXTURE_EVIDENCE` to an external directory to retain them elsewhere.
