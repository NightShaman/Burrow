# Audit remediation browser fixture (local only)

Root: `/tmp/hatchet-audit-20261106/ui/source`. Fixture sources only under this directory. The fixture imports actual candidate `src/` components at build time; it does not copy production modules. All API responses are in-memory mocked, including accepted NDJSON chat, deferred task/provider writes and OAuth start; it never contacts a backend or provider. A static Python server uses an OS-selected loopback port, serves only the generated `bundle/`, and sets `connect-src 'none'`. CDP Chromium uses a disposable profile and 1920×1200 viewport. Node dependency resolution follows the pre-existing `node_modules` symlink; do not install into/mutate its target.

From the target root:

```sh
node scripts/audit-remediation-fixture/build.mjs
node scripts/audit-remediation-fixture/headless.mjs
```

Set `CHROMIUM_BIN` if necessary and `AUDIT_EVIDENCE_DIR` to override the default `/tmp/hatchet-audit-20261106/ui/browser`. The runner records PNG captures, `results.json` (observed DOM/requests, exceptions, network origins, viewport), and exits nonzero on a missing expected interaction. It is an interaction-observation runner: inspect `results.json` and paired PNGs rather than treating a zero exit as independent visual acceptance. Browser routes, on the random port printed in `results.json`:

- `/?route=app`: actual App, right-only Workspace polling; synthetic accepted chat partial stream and controlled error, conversation A/B selector. `window.fixtureFailChat()` releases the failed stream.
- `/?route=settings`: actual Settings, Models provider save, Agents/Dreams, General/Rail panels, declarative mod form. `window.fixtureSetTab('agents'|'general'|'connections'|'mods')`; `window.fixtureSetOwnerOnly(true|false)`; `window.fixtureDelayModelSave()` and `window.fixtureReleaseModelSave()`. The synthetic extension is built from `fixture-mod.js` into same-origin `/api/mods/fixture-extension/ui/settings.js`.
- `/?route=tasks`: actual Tasks task/project editors, mocked delayed PATCH. `window.fixtureHoldSave()` then `window.fixtureReleaseSave()`.
- `/?route=archive`: actual TiddleArchiveShelf with two deterministic cards and deferred A pagination. `window.fixtureReleaseHistory()`.
- `/?route=first-run`: actual mandatory FirstRunSetup; advance Start fresh, Next, enter agent name, Next twice; select OpenAI; Escape closes nested OAuth while mandatory wizard stays.
- `/?route=auth&mode=basic|none|invalid`: actual `discoverAuthMode()` with backend-shaped nested payload.

Paired **before** evidence is a detached `aa759fb` baseline worktree at `/tmp/hatchet-audit-20261106/ui/browser/baseline`. The fixture-only files were copied into the baseline tree, built there with the same existing dependency symlink, and run with `AUDIT_EVIDENCE_DIR=/tmp/hatchet-audit-20261106/ui/browser/before`. The baseline runner allows the observed API01 mismatch and CLEAN03 Escape failure to capture all later findings; it never treats those observations as passing behavior. The runner's built-in source-root and parent path are deliberately both made explicit by invocation cwd. Do not interpret the baseline generated `bundle/` or fixture files as original repository content.

**Covered interactions:** SET01 dirty section navigation + cancelable beforeunload, SET02 second POST, SET03 credential retention after delayed POST, CLEAN03 nested Escape, UI01 accepted partial failed stream + origin refresh, UI02 A→B switch/error attribution, UI03 right-only Workspace initial polling, UI04 Alt+ArrowUp list reorder/focus/announcement, UI05 owner-only panel options, API01 nested discovery, UITASK01 task/project edits during PATCH, UIARC01 A→B pagination, Dream/Minion primary vs supporting headings. Not full coverage: SET01 busy mod action; actual native Basic challenge, login and credential checks; UI03 polling cadence beyond first request; UI04 assistive technology; UITASK01 upload failure; UIARC01 network error branch; live integration; pixel-quality signoff. Provider old/new credentials in evidence are synthetic placeholders only. Real backend/providers never contacted.
